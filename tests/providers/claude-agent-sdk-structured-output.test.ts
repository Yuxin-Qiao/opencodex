import { parseRequest } from "../../src/responses/parser";
import { buildResponseJSON } from "../../src/bridge";
import { describe, expect, test } from "bun:test";
import { createClaudeAgentSdkAdapter, type ClaudeAgentSdkModule } from "../../src/adapters/claude-agent-sdk/adapter";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { CLAUDE_AGENT_SDK_MCP_SERVER_NAME } from "../../src/adapters/claude-agent-sdk/sdk-bridge";

const schema = { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false };
const format = { type: "json_schema" as const, name: "record", strict: true, schema };
const provider = { adapter: "claude-agent-sdk", baseUrl: "https://api.anthropic.com", models: ["claude-sonnet-5"] } as OcxProviderConfig;
const parsed = (overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest => ({ modelId: "claude-sonnet-5", stream: true,
  options: { textFormat: format }, context: { messages: [{role:"user", content:"return record",timestamp:0}] }, ...overrides } as OcxParsedRequest);
const init = {type:"system",subtype:"init",mcp_servers:[{name:CLAUDE_AGENT_SDK_MCP_SERVER_NAME,status:"connected",source:"sdk"}]};
const delta = (text: string) => ({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text}}});
const result = (payload: unknown) => ({type:"result",subtype:"success",is_error:false,structured_output:payload,usage:{input_tokens:3,output_tokens:2}});
const call = (name: string) => [
 {type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"tool_use",id:"call-demo",name}}},
 {type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:'{"id":"demo"}'}}},
 {type:"stream_event",event:{type:"content_block_stop",index:0}},
];

async function run(frames: unknown[], request = parsed(), controller?: AbortController) {
  const options: Record<string,unknown>[] = []; const prompts: unknown[] = []; const removed: string[] = []; let loads = 0;
  const sdk: ClaudeAgentSdkModule = {query(input) {
    options.push(input.options);
    return (async function* () {
      if (typeof input.prompt !== "string") for await (const frame of input.prompt) prompts.push(frame);
      for (const frame of frames) yield frame as Record<string,unknown>;
    })();
  }};
  const adapter = createClaudeAgentSdkAdapter(provider, {loadSdk: async()=>{loads++;return sdk;},
    makeScratchDir: async()=>"/tmp/ocx-structured-fixture",removeScratchDir: async p=>{removed.push(p);controller?.abort();}});
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(request,{headers:new Headers(),translatorBudget:createTestTranslatorBudget(),abortSignal:controller?.signal}, event=>{
    if (event.type==="text_delta") expect(removed).toHaveLength(1);
    events.push(event);
  });
  return {events,options,prompts,loads};
}

describe("Claude Agent SDK structured output",()=>{
 test("projects the exact schema and returns one validated JSON after cleanup",async()=>{
   const actual=await run([init,delta("unvalidated draft"),{type:"assistant",message:{content:[{type:"text",text:"duplicate draft"}]}},result({id:"demo"})]);
   expect(actual.options[0]!.outputFormat).toEqual({type:"json_schema",schema});
   expect(actual.options[0]).toMatchObject({tools:[],settingSources:[],persistSession:false,strictMcpConfig:true});
   expect(actual.events.filter(e=>e.type==="text_delta")).toEqual([{type:"text_delta",text:'{"id":"demo"}'}]);
   expect(actual.events.at(-1)).toMatchObject({type:"done",usage:{inputTokens:3,outputTokens:2}});
 });
 test.each([{id:4},{id:"demo",extra:true},null])("rejects an invalid final payload %j",async payload=>{
   const actual=await run([init,delta("draft"),result(payload)]);
   expect(actual.events.some(e=>e.type==="text_delta")).toBe(false);
   expect(actual.events.at(-1)).toMatchObject({type:"error",code:"structured_output_invalid",retryable:false});
 });
 test("unserializable SDK output fails without reflecting private field names",async()=>{
   const payload: Record<string,unknown> = {}; payload.privateFixture = payload;
   const actual=await run([init,result(payload)]);
   expect(actual.events.at(-1)).toMatchObject({type:"error",code:"structured_output_invalid"});
   expect(JSON.stringify(actual.events)).not.toContain("privateFixture");
 });
 test("missing structured output cannot finish successfully",async()=>{
   expect((await run([init,{type:"result",subtype:"success",is_error:false}])).events.at(-1)).toMatchObject({type:"error",code:"structured_output_invalid"});
 });
 test.each(["error_max_structured_output_retries","error_max_turns","error_during_execution"])("keeps SDK %s as a failure",async subtype=>{
   const actual=await run([init,delta("draft"),{type:"result",subtype,is_error:true,errors:["synthetic refusal"]}]);
   expect(actual.events.at(-1)?.type).toBe("error"); expect(actual.events.some(e=>e.type==="text_delta")).toBe(false);
 });
 test("internal formatting blocks do not become caller tool calls",async()=>{
   const actual=await run([init,...call("StructuredOutput"),{type:"stream_event",event:{type:"message_stop"}},result({id:"demo"})]);
   expect(actual.events.some(e=>e.type.startsWith("tool_call"))).toBe(false);
   expect(actual.events.at(-1)?.type).toBe("done");
 });
 test("incomplete internal formatting block fails without output",async()=>{
   const actual=await run([init,call("StructuredOutput")[0],result({id:"demo"})]);
   expect(actual.events.at(-1)?.type).toBe("error");expect(actual.events.some(e=>e.type==="text_delta")).toBe(false);
 });
 test("overlapping formatter and caller tool blocks fail closed",async()=>{
   const actual=await run([init,call("StructuredOutput")[0],...call("undeclared"),result({id:"demo"})]);
   expect(actual.events.at(-1)?.type).toBe("error");expect(actual.events.some(e=>e.type.startsWith("tool_call"))).toBe(false);
 });
 test.each(["bytes","depth","nodes"])("schema %s limit refuses before SDK loading",async limit=>{
   let huge: Record<string,unknown>;
   if (limit==="bytes") huge={type:"string",description:"x".repeat(65536)};
   else if (limit==="nodes") huge={type:"object",properties:Object.fromEntries(Array.from({length:1025},(_,i)=>["p"+i,{type:"string"}]))};
   else {huge={type:"string"};for(let i=0;i<34;i++) huge={type:"array",items:huge};}
   const actual=await run([],parsed({options:{textFormat:{...format,schema:huge}}}));
   expect(actual.loads).toBe(0);expect(actual.events.at(-1)).toMatchObject({type:"error",status:400});
 });
 test("valid scalar JSON is returned without truthiness tests",async()=>{
   const actual=await run([init,result(false)],parsed({options:{textFormat:{...format,schema:{type:"boolean"}}}}));
   expect(actual.events.filter(e=>e.type==="text_delta")).toEqual([{type:"text_delta",text:"false"}]);
   expect(actual.events.at(-1)?.type).toBe("done");
 });
 test("cancellation during cleanup withholds validated output",async()=>{
   const actual=await run([init,result({id:"demo"})],parsed(),new AbortController());
   expect(actual.events.some(e=>e.type==="text_delta")).toBe(false); expect(actual.events.at(-1)?.type).toBe("error");
 });
 test.each([
  {type:"json_object"}, {type:"json_schema"}, {type:"json_schema",schema:{type:"invalid"}},
  {type:"json_schema",schema:{type:"string",format:"email"}},
  {type:"json_schema",schema:{$ref:"https://example.invalid/schema"}},
  {type:"json_schema",schema:{type:"object",properties:{id:{type:"string",pattern:".*"}}}},
  {type:"json_schema",schema:{type:"object",unknownConstraint:true}},
 ])("rejects unsupported schema before loading SDK %j",async textFormat=>{
   const actual=await run([],parsed({options:{textFormat:textFormat as typeof format}}));
   expect(actual.loads).toBe(0);expect(actual.events.at(-1)).toMatchObject({type:"error",status:400,code:"structured_output_schema_invalid"});
 });
 test("external caller tool result continues into a validated final answer",async()=>{
   const tools=[{name:"lookup_record",description:"Read record",parameters:schema}];
   const firstBody={model:"claude-sonnet-5",input:"Read record demo",tools:tools.map(t=>({type:"function",...t})),text:{format}};
   const first=await run([init,...call(`mcp__${CLAUDE_AGENT_SDK_MCP_SERVER_NAME}__lookup_record`),{type:"stream_event",event:{type:"message_stop"}}],parseRequest(firstBody));
   const firstResponse=buildResponseJSON(first.events,"claude-sonnet-5");
   const returned=(firstResponse.output as Record<string,unknown>[]).find(item=>item.type==="function_call")!;
   expect(returned).toMatchObject({type:"function_call",call_id:"call-demo",name:"lookup_record",arguments:'{"id":"demo"}'});
   expect(first.events.at(-1)).toMatchObject({type:"done",stopReason:"tool_use"});
   // The caller owns execution; feed its result through the real Responses input parser.
   const second=await run([init,result({id:"demo"})],parseRequest({...firstBody,input:[
     {role:"user",content:"Read record demo"},returned,
     {type:"function_call_output",call_id:returned.call_id,output:'{"id":"demo"}'}]}));
   const finalResponse=buildResponseJSON(second.events,"claude-sonnet-5");
   expect(finalResponse.status).toBe("completed");
   expect(JSON.stringify(finalResponse.output)).toContain("demo");
   expect(JSON.stringify(second.prompts)).toContain("demo");expect(JSON.stringify(second.prompts)).toContain("lookup_record");
   expect(second.events.filter(e=>e.type==="text_delta")).toEqual([{type:"text_delta",text:'{"id":"demo"}'}]);
   expect(second.events.at(-1)?.type).toBe("done");
 });
});
