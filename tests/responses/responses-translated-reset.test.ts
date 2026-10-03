import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

async function probe(options: {
  provider?: Partial<OcxProviderConfig>;
  body?: Record<string, unknown>;
  resets?: number;
  exhausted?: boolean;
  abort?: boolean;
  spentGrant?: boolean;
  downgrade?: boolean;
}) {
  const home = mkdtempSync(join(tmpdir(), "ocx-translated-reset-"));
  const oldHome = process.env.OPENCODEX_HOME;
  const oldFetch = globalThis.fetch;
  process.env.OPENCODEX_HOME = home;
  const release = acquireOwnedSpendHome();
  const budget = createRequestExecutionBudget();
  if (options.exhausted) budget.used = 3;
  if (options.spentGrant) budget.claimAmbiguousResend(1);
  const abort = new AbortController();
  const bodies: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(String(init?.body));
    if (options.abort) abort.abort();
    if (options.downgrade && bodies.length === 1) {
      return Response.json({ error: { type: "invalid_request_error", param: "reasoning_effort",
        message: "reasoning_effort max is not supported for this model" } }, { status: 400 });
    }
    if (bodies.length <= (options.resets ?? 1) + (options.downgrade ? 1 : 0)) {
      throw Object.assign(new Error("synthetic pre-header reset"), { code: "ECONNRESET" });
    }
    return Response.json({ id: "chat-test", choices: [{ index: 0,
      message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
  }) as typeof fetch;
  try {
    const config = { port: 0, defaultProvider: "mock", providers: {
      mock: { adapter: "openai-chat", baseUrl: "https://synthetic.invalid/v1", apiKey: "synthetic",
        models: ["test"], retryOnReset: {}, ...options.provider },
    } } as OcxConfig;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test", input: "hello", store: false, stream: false, ...options.body }),
    }), config, { model: "", provider: "" }, { sendBudget: budget, abortSignal: abort.signal });
    return { status: response.status, text: await response.text(), bodies, used: budget.used };
  } finally {
    globalThis.fetch = oldFetch;
    release();
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
}

describe("translated Responses pre-header reset replay (#6510)", () => {
  test("a bare opt-in replays identical chat bytes once and charges both sends", async () => {
    const result = await probe({});
    expect(result.status, result.text).toBe(200);
    expect(result.bodies).toHaveLength(2);
    expect(result.bodies[0]).toBe(result.bodies[1]);
    expect(result.used).toBe(2);
  });

  test.each([
    ["absent opt-in", { provider: { retryOnReset: undefined } }],
    ["disabled opt-in", { provider: { retryOnReset: { enabled: false } } }],
    ["stored turn", { body: { store: true } }],
    ["spent request-wide replacement", { spentGrant: true }],
    ["exact one-send policy", { provider: { transientRetryOn5xx: { attempts: 1 } } }],
  ] as const)("%s does not fund a duplicate turn", async (_name, options) => {
    const result = await probe(options);
    expect(result.status).toBe(429);
    expect(result.text).toContain("upstream_reset_replay_refused");
    expect(result.bodies).toHaveLength(1);
  });

  test("a reset during a rebuilt effort-downgrade send uses the same grant", async () => {
    const result = await probe({ downgrade: true, provider: { reasoningEfforts: ["high", "max"] },
      body: { reasoning: { effort: "max" } } });
    expect(result.status, result.text).toBe(200);
    expect(result.bodies).toHaveLength(3);
    expect(result.bodies[1]).toBe(result.bodies[2]);
    expect(result.used).toBe(3);
  });

  test("repeated resets exhaust the grant after two sends", async () => {
    const result = await probe({ resets: 10 });
    expect(result.status).toBe(429);
    expect(result.bodies).toHaveLength(2);
    expect(result.used).toBe(2);
  });

  test("exhausted send budget blocks dispatch", async () => {
    const result = await probe({ exhausted: true });
    expect(result.status).toBe(429);
    expect(result.bodies).toHaveLength(0);
  });

  test("cancellation never spends the replacement", async () => {
    const result = await probe({ abort: true });
    expect(result.status).toBe(499);
    expect(result.bodies).toHaveLength(1);
  });
});
