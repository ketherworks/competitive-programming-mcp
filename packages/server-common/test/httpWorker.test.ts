import { describe, expect, test, vi } from "vitest";
import {
  applyCorsHeaders,
  buildCorsHeaders,
  handleCorsPreflight,
  hasCredentialHeaders,
  isTimeoutError,
  jsonResponse,
  jsonRpcErrorResponse,
  parseBoundedMcpJsonPost,
  parseRetryAfterMs,
  sha256Hex,
  validateAllowedOrigin,
  validateContentLength
} from "../src/index.js";

describe("HTTP worker CORS, origin, and credential guards", () => {
  test("validates exact and wildcard origins and applies CORS headers cleanly", async () => {
    const noOrigin = new Request("https://mcp.example/mcp", { method: "POST" });
    expect(validateAllowedOrigin(noOrigin, undefined)).toBeUndefined();
    expect(applyCorsHeaders(jsonResponse({ ok: true }), noOrigin, "https://app.example").headers.has("vary")).toBe(false);

    const disallowed = new Request("https://mcp.example/mcp", {
      method: "POST",
      headers: { origin: "https://evil.example" }
    });
    expect(validateAllowedOrigin(disallowed, "https://app.example")?.status).toBe(403);

    const allowed = new Request("https://mcp.example/mcp", {
      method: "POST",
      headers: { origin: "https://app.example" }
    });
    expect(validateAllowedOrigin(allowed, " https://other.example , https://app.example ")).toBeUndefined();

    const corsResponse = applyCorsHeaders(jsonResponse({ ok: true }), allowed, "https://app.example");
    expect(corsResponse.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(corsResponse.headers.get("vary")).toBe("Origin");

    const wildcardPreflight = handleCorsPreflight(disallowed, "*");
    expect(wildcardPreflight.status).toBe(204);
    expect(wildcardPreflight.headers.get("access-control-allow-origin")).toBe("*");

    const deniedPreflight = handleCorsPreflight(disallowed, "https://app.example");
    expect(deniedPreflight.status).toBe(403);

    const unallowedHeaders = buildCorsHeaders(disallowed, "https://app.example");
    expect(unallowedHeaders.has("access-control-allow-origin")).toBe(false);
    expect(unallowedHeaders.get("access-control-expose-headers")).toBe("mcp-session-id");
  });

  test("detects credential headers and emits structured JSON-RPC errors", async () => {
    expect(hasCredentialHeaders(new Request("https://mcp.example/mcp"))).toBe(false);
    expect(hasCredentialHeaders(new Request("https://mcp.example/mcp", { headers: { cookie: "sid=1" } }))).toBe(true);
    expect(hasCredentialHeaders(new Request("https://mcp.example/mcp", { headers: { authorization: "Bearer x" } }))).toBe(true);

    const rpc = jsonRpcErrorResponse(400, -32600, "Batch unsupported", { detail: true }, { "Retry-After": "1" });
    expect(rpc.status).toBe(400);
    expect(rpc.headers.get("retry-after")).toBe("1");
    await expect(rpc.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Batch unsupported", data: { detail: true } }
    });
  });
});

describe("parseBoundedMcpJsonPost", () => {
  test("validates Content-Length including values above MAX_SAFE_INTEGER", () => {
    expect(validateContentLength(null, 64)).toBe("ok");
    expect(validateContentLength("64", 64)).toBe("ok");
    expect(validateContentLength("65", 64)).toBe("too_large");
    expect(validateContentLength("999999999999999999999999999", 64)).toBe("too_large");
    expect(validateContentLength("-1", 64)).toBe("invalid");
    expect(validateContentLength("12.5", 64)).toBe("invalid");
    expect(validateContentLength("abc", 64)).toBe("invalid");
  });

  test("rejects invalid Content-Length, oversized declared/streamed bodies, invalid UTF-8, batches, and non-object JSON", async () => {
    const invalidLen = await parseBoundedMcpJsonPost(
      new Request("https://mcp.example/mcp", { method: "POST", headers: { "content-length": "NaN" }, body: "{}" }),
      { maxBytes: 64, ingressTimeoutMs: 1_000 }
    );
    expect(invalidLen).toEqual({ ok: false, kind: "invalid_content_length" });

    const hugeDeclared = await parseBoundedMcpJsonPost(
      new Request("https://mcp.example/mcp", {
        method: "POST",
        headers: { "content-length": "9999999999999999999999999" },
        body: "{}"
      }),
      { maxBytes: 64, ingressTimeoutMs: 1_000 }
    );
    expect(hugeDeclared).toEqual({ ok: false, kind: "too_large" });

    const streamedOverflow = await parseBoundedMcpJsonPost(
      new Request("https://mcp.example/mcp", { method: "POST", body: "a".repeat(65) }),
      { maxBytes: 64, ingressTimeoutMs: 1_000 }
    );
    expect(streamedOverflow).toEqual({ ok: false, kind: "too_large" });

    const badUtf8 = await parseBoundedMcpJsonPost(
      new Request("https://mcp.example/mcp", { method: "POST", body: new Uint8Array([0xff, 0xfe]) }),
      { maxBytes: 64, ingressTimeoutMs: 1_000, fatalUtf8: true }
    );
    expect(badUtf8).toEqual({ ok: false, kind: "invalid_utf8" });

    const malformed = await parseBoundedMcpJsonPost(
      new Request("https://mcp.example/mcp", { method: "POST", body: "{not-json" }),
      { maxBytes: 64, ingressTimeoutMs: 1_000 }
    );
    expect(malformed).toEqual({ ok: false, kind: "invalid_json" });

    const batch = await parseBoundedMcpJsonPost(
      new Request("https://mcp.example/mcp", { method: "POST", body: "[]" }),
      { maxBytes: 64, ingressTimeoutMs: 1_000 }
    );
    expect(batch).toEqual({ ok: false, kind: "batch_unsupported" });

    const scalar = await parseBoundedMcpJsonPost(
      new Request("https://mcp.example/mcp", { method: "POST", body: "null" }),
      { maxBytes: 64, ingressTimeoutMs: 1_000, requireJsonObject: true }
    );
    expect(scalar).toEqual({ ok: false, kind: "non_object_json" });

    const missing = await parseBoundedMcpJsonPost(
      new Request("https://mcp.example/mcp", { method: "POST" }),
      { maxBytes: 64, ingressTimeoutMs: 1_000, requireBody: true }
    );
    expect(missing).toEqual({ ok: false, kind: "missing_body" });
  });

  test("times out stalled streams under fake timers without blocking on hanging cancel", async () => {
    vi.useFakeTimers();
    try {
      let cancelStarted = false;
      const stalledBody = new ReadableStream<Uint8Array>({
        cancel() {
          cancelStarted = true;
          return new Promise<void>(() => undefined);
        }
      });
      const request = new Request("https://mcp.example/mcp", {
        method: "POST",
        body: stalledBody,
        duplex: "half"
      } as RequestInit);

      const pending = parseBoundedMcpJsonPost(request, { maxBytes: 64, ingressTimeoutMs: 30 });
      await vi.advanceTimersByTimeAsync(30);
      await expect(pending).resolves.toEqual({ ok: false, kind: "timeout" });
      expect(cancelStarted).toBe(true);
      expect(stalledBody.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HTTP & crypto utilities", () => {
  test("parses Retry-After delta-seconds and HTTP-date headers with bounds", () => {
    const now = () => Date.UTC(2026, 6, 11, 0, 0, 0);
    expect(parseRetryAfterMs("3", { now })).toBe(3_000);
    expect(parseRetryAfterMs("0", { now })).toBe(0);
    expect(parseRetryAfterMs("-5", { now })).toBeUndefined();
    expect(parseRetryAfterMs("999999", { now, maxMs: 60_000, clamp: true })).toBe(60_000);
    expect(parseRetryAfterMs("999999", { now, maxMs: 60_000, clamp: false })).toBeUndefined();
    expect(parseRetryAfterMs("Sat, 11 Jul 2026 00:00:10 GMT", { now })).toBe(10_000);
    expect(parseRetryAfterMs("Sat, 11 Jul 2026 00:00:10 GMT", { now, allowHttpDate: false })).toBeUndefined();
    expect(parseRetryAfterMs("Fri, 10 Jul 2026 23:59:50 GMT", { now, clamp: true })).toBe(0);
    expect(parseRetryAfterMs("Fri, 10 Jul 2026 23:59:50 GMT", { now, clamp: false })).toBeUndefined();
    expect(parseRetryAfterMs("not-a-date", { now })).toBeUndefined();
  });

  test("classifies timeout errors across direct and nested cause shapes", () => {
    expect(isTimeoutError(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isTimeoutError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isTimeoutError(new DOMException("aborted", "AbortError"), { includeAbortError: false })).toBe(false);
    expect(isTimeoutError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isTimeoutError({ code: "UND_ERR_CONNECT_TIMEOUT" })).toBe(true);
    expect(isTimeoutError({ cause: { code: "ETIMEDOUT" } })).toBe(true);
    expect(isTimeoutError(new Error("generic"))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
  });

  test("computes deterministic lowercase SHA-256 hex digests", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
