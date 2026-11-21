import { ojErrorSchema, ojProviderHealthSchema } from "@kaiserunix/oj-mcp-contracts";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  combineAbortSignals,
  createPermissiveCallToolRequestSchema,
  defineOjTool,
  executeOjToolCall,
  extractBoundedRequestId,
  MonotonicHealthStore,
  normalizeOjError,
  OjAdapterError,
  OjRequestCancelledError,
  readToolArguments,
  readToolName,
  strictEmptyInputSchema
} from "../src/index.js";

describe("MCP tool definition and permissive call normalization", () => {
  test("defines tools with strict annotations and success-or-error output schemas", () => {
    const readTool = defineOjTool({
      name: "oj_health",
      title: "Health",
      description: "Read health",
      inputSchema: strictEmptyInputSchema,
      outputSchema: ojProviderHealthSchema,
      openWorldHint: false
    });
    const localTool = defineOjTool({
      name: "oj_prepare",
      title: "Prepare",
      description: "Prepare write",
      inputSchema: strictEmptyInputSchema,
      outputSchema: ojProviderHealthSchema,
      openWorldHint: true,
      behavior: "localAction"
    });
    const submitTool = defineOjTool({
      name: "oj_submit",
      title: "Submit",
      description: "Real submit",
      inputSchema: strictEmptyInputSchema,
      outputSchema: ojProviderHealthSchema,
      openWorldHint: true,
      behavior: "realSubmit"
    });

    expect(readTool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(localTool.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(submitTool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect((readTool.outputSchema as { anyOf?: unknown[] }).anyOf).toHaveLength(2);
  });

  test("normalizes malformed tools/call params while permitting _meta", () => {
    const schema = createPermissiveCallToolRequestSchema("__invalid__");

    expect(schema.parse({ method: "tools/call" }).params).toEqual({
      name: "__invalid__",
      arguments: { __invalidCallParams: true }
    });
    expect(schema.parse({ method: "tools/call", params: "bad" }).params).toEqual({
      name: "__invalid__",
      arguments: { __invalidCallParams: true }
    });
    expect(schema.parse({ method: "tools/call", params: { name: "oj_health", arguments: ["bad"] } }).params).toEqual({
      name: "oj_health",
      arguments: { __invalidArguments: true }
    });
    expect(schema.parse({ method: "tools/call", params: { name: "oj_health", extraField: 1 } }).params).toEqual({
      name: "oj_health",
      arguments: { __invalidCallParams: true }
    });

    const validWithMeta = schema.parse({
      method: "tools/call",
      params: { name: "oj_health", arguments: { requestId: "req-1" }, _meta: { progressToken: "tok" } }
    });
    expect(readToolName(validWithMeta.params)).toBe("oj_health");
    expect(readToolArguments(validWithMeta.params)).toEqual({ requestId: "req-1" });
    expect(extractBoundedRequestId(readToolArguments(validWithMeta.params))).toBe("req-1");
    expect(extractBoundedRequestId({ requestId: "x".repeat(129) })).toBeUndefined();
    expect(extractBoundedRequestId({ requestId: "" })).toBeUndefined();
  });
});

describe("Error normalization and safe tool execution", () => {
  const normalizer = {
    platform: "atcoder" as const,
    providerId: "test-provider",
    internalMessage: "Sanitized internal failure."
  };

  test("sanitizes unknown errors without leaking raw error text and preserves OjAdapterError metadata", () => {
    const adapter = normalizeOjError(
      new OjAdapterError("rate_limited", "Slow down", { httpStatus: 429, retryAfterMs: 2_500 }),
      normalizer,
      "req-42"
    );
    expect(ojErrorSchema.safeParse(adapter).success).toBe(true);
    expect(adapter).toMatchObject({
      code: "rate_limited",
      layer: "upstream",
      httpStatus: 429,
      retryAfterMs: 2_500,
      requestId: "req-42"
    });

    const unknown = normalizeOjError(new Error("SECRET_COOKIE=abc123"), normalizer, "req-43");
    expect(ojErrorSchema.safeParse(unknown).success).toBe(true);
    expect(unknown).toMatchObject({
      code: "internal",
      layer: "broker",
      message: "Sanitized internal failure.",
      requestId: "req-43"
    });
    expect(JSON.stringify(unknown)).not.toContain("SECRET_COOKIE");
  });

  test("executeOjToolCall returns structured results, normalizes errors, and rethrows cancellations", async () => {
    const ok = await executeOjToolCall(async () => ({ ok: true }), { errorNormalizer: normalizer });
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).toEqual({ ok: true });

    const err = await executeOjToolCall(
      async () => {
        throw new OjAdapterError("resource.not_found", "Missing problem", { httpStatus: 404 });
      },
      { errorNormalizer: normalizer, requestId: "req-1" }
    );
    expect(err.isError).toBe(true);
    expect(err.structuredContent).toMatchObject({ code: "resource.not_found", httpStatus: 404, requestId: "req-1" });

    await expect(
      executeOjToolCall(
        async () => {
          throw new OjRequestCancelledError("cancelled");
        },
        { errorNormalizer: normalizer }
      )
    ).rejects.toBeInstanceOf(OjRequestCancelledError);

    const abort = new AbortController();
    abort.abort(new DOMException("client left", "AbortError"));
    await expect(
      executeOjToolCall(
        async () => {
          throw new Error("interrupted");
        },
        { errorNormalizer: normalizer, signal: abort.signal }
      )
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("MonotonicHealthStore and combineAbortSignals", () => {
  test("ignores stale out-of-order health observations", () => {
    const store = new MonotonicHealthStore<string>();
    const first = store.begin();
    const second = store.begin();

    store.recordSuccess(second, "2026-07-11T00:00:02.000Z", 15);
    store.recordError(first, "2026-07-11T00:00:01.000Z", "stale failure", 200);

    expect(store.snapshot()).toEqual({
      sequence: second,
      checkedAt: "2026-07-11T00:00:02.000Z",
      latencyMs: 15
    });

    const third = store.begin();
    store.recordError(third, "2026-07-11T00:00:03.000Z", "fresh failure", -5);
    expect(store.snapshot()).toEqual({
      sequence: third,
      checkedAt: "2026-07-11T00:00:03.000Z",
      latencyMs: 0,
      error: "fresh failure"
    });
  });

  test("combineAbortSignals propagates abort from any parent and cleans up listeners on dispose", () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineAbortSignals(a.signal, b.signal);
    expect(combined.signal.aborted).toBe(false);

    b.abort(new DOMException("b aborted", "AbortError"));
    expect(combined.signal.aborted).toBe(true);
    combined.dispose();

    const c = new AbortController();
    const d = new AbortController();
    const disposed = combineAbortSignals(c.signal, d.signal);
    disposed.dispose();
    c.abort(new DOMException("late", "AbortError"));
    expect(disposed.signal.aborted).toBe(false);

    // Ensure z schema export sanity check.
    expect(strictEmptyInputSchema.safeParse({}).success).toBe(true);
    expect(strictEmptyInputSchema.safeParse({ extra: z.string() }).success).toBe(false);
  });
});
