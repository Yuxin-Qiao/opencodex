import Ajv, { type ValidateFunction } from "ajv";
import type { AdapterEvent, OcxParsedRequest } from "../../types";
import type { StreamMessage, StreamParseState } from "../coding-agent/protocol";

/** Compile without coercion, defaults, remote loading or weakening caller constraints. */
export class StructuredOutput {
  private readonly validate: ValidateFunction;
  private readonly internalBlocks = new Set<number>();
  text: string | undefined;
  private formattingCalls = 0;

  constructor(format: NonNullable<OcxParsedRequest["options"]["textFormat"]>) {
    if (format.type !== "json_schema" || !format.schema || typeof format.schema !== "object" || Array.isArray(format.schema)) {
      throw new Error("This provider requires text.format.json_schema with an object schema.");
    }
    if (Buffer.byteLength(JSON.stringify(format.schema)) > 64 * 1024) throw new Error("Output schema exceeds 64 KiB.");
    checkSchema(format.schema);
    this.validate = new Ajv({ strict: true, strictTypes: false, strictRequired: false, allErrors: false }).compile(format.schema);
  }

  /** Internal output formatting never becomes a caller-owned tool call. */
  frame(message: StreamMessage): StreamMessage | undefined {
    if (message.type === "stream_event") {
      const event = message.event as Record<string, unknown> | undefined;
      const block = event?.content_block as Record<string, unknown> | undefined;
      const index = event?.index;
      if (typeof index === "number") {
        if (event?.type === "content_block_start" && this.internalBlocks.has(index)) throw new Error("Overlapping SDK formatting block.");
        if (event?.type === "content_block_start" && block?.type === "tool_use" && block.name === "StructuredOutput") {
          if (++this.formattingCalls > 16 || this.internalBlocks.size > 0) throw new Error("Invalid or excessive SDK formatting blocks.");
          this.internalBlocks.add(index);
        }
        if (this.internalBlocks.has(index)) {
          if (event?.type === "content_block_stop") this.internalBlocks.delete(index);
          return undefined;
        }
      }
    }
    if (this.internalBlocks.size > 0 && (message.type === "result" || (message.event as Record<string, unknown> | undefined)?.type === "message_stop")) throw new Error("Incomplete SDK formatting block.");
    if (message.type === "assistant") {
      const body = message.message as Record<string, unknown> | undefined;
      if (Array.isArray(body?.content)) return { ...message, message: { ...body, content: body.content.filter(part =>
        !(part && typeof part === "object" && part.type === "tool_use" && part.name === "StructuredOutput")) } };
    }
    return message;
  }

  events(message: StreamMessage, state: StreamParseState, events: AdapterEvent[]): AdapterEvent[] {
    const filtered = events.filter(event => event.type !== "text_delta");
    // An external tool leg owes a call, not a final JSON answer; its caller will continue it.
    if (message.type !== "result" || (state.completedToolCalls ?? 0) > 0 || !filtered.some(event => event.type === "done")) return filtered;
    if (message.subtype !== "success" || message.is_error === true || !Object.hasOwn(message, "structured_output")) {
      return [{ type: "error", message: "Claude Agent SDK did not return a schema-valid structured result.", status: 502,
        errorType: "upstream_error", code: "structured_output_invalid", retryable: false }];
    }
    try {
      const text = JSON.stringify(message.structured_output);
      if (text === undefined || Buffer.byteLength(text) > 8 * 1024 * 1024 || !this.validate(message.structured_output)) throw new Error("invalid");
      this.text = text;
    } catch {
      return [{ type: "error", message: "Claude Agent SDK structured result is invalid or exceeds the output limit.", status: 502,
        errorType: "upstream_error", code: "structured_output_invalid", retryable: false }];
    }
    return filtered;
  }
}

function checkSchema(schema: unknown, depth = 0, counter = { nodes: 0 }): void {
  if (++counter.nodes > 1024 || depth > 32) throw new Error("Output schema exceeds complexity limits.");
  if (typeof schema === "boolean") return;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Invalid output schema.");
  const value = schema as Record<string, unknown>;
  // Regex/format semantics differ across the SDK and local validators; reject instead of weakening them.
  if ("pattern" in value || "patternProperties" in value || "format" in value || "$async" in value) throw new Error("Regex, format and async output schemas are unsupported.");
  if (typeof value.$ref === "string" && !value.$ref.startsWith("#")) throw new Error("Only local output schema references are supported.");
  for (const key of ["properties", "definitions", "$defs", "dependentSchemas"]) {
    const map = value[key];
    if (map && typeof map === "object" && !Array.isArray(map)) for (const child of Object.values(map)) checkSchema(child, depth + 1, counter);
  }
  for (const key of ["items", "additionalProperties", "additionalItems", "contains", "not", "if", "then", "else", "propertyNames"]) {
    if (value[key] !== undefined) {
      const children = Array.isArray(value[key]) ? value[key] as unknown[] : [value[key]];
      for (const child of children) checkSchema(child, depth + 1, counter);
    }
  }
  if (value.dependencies && typeof value.dependencies === "object") for (const child of Object.values(value.dependencies)) {
    if (!Array.isArray(child)) checkSchema(child, depth + 1, counter);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) if (Array.isArray(value[key])) for (const child of value[key] as unknown[]) checkSchema(child, depth + 1, counter);
}
