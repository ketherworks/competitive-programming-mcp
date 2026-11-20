import { cancelRequestBody } from "./abort.js";
import { parseCsvList } from "./bounds.js";
import { BoundedBodyError, readBoundedUtf8, validateContentLength } from "./http.js";

export const MCP_CORS_ALLOW_HEADERS = "content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id";
export const MCP_CORS_ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
export const MCP_CORS_EXPOSE_HEADERS = "mcp-session-id";

export function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders }
  });
}

export function jsonRpcErrorResponse(
  status: number,
  code: number,
  message: string,
  data?: unknown,
  extraHeaders?: Record<string, string>
): Response {
  return jsonResponse(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code, message, ...(data === undefined ? {} : { data }) }
    },
    status,
    extraHeaders
  );
}

export function hasCredentialHeaders(request: Request): boolean {
  return request.headers.has("authorization") || request.headers.has("cookie");
}

export function validateAllowedOrigin(
  request: Request,
  allowedOriginsCsv: string | undefined
): Response | undefined {
  const origin = request.headers.get("origin");
  if (!origin) return undefined;
  const allowed = parseCsvList(allowedOriginsCsv);
  if (allowed.includes("*") || allowed.includes(origin)) return undefined;
  return jsonResponse({ error: "Origin is not allowed." }, 403);
}

export function buildCorsHeaders(request: Request, allowedOriginsCsv: string | undefined): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin");
  const allowed = parseCsvList(allowedOriginsCsv);
  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    headers.set("Access-Control-Allow-Origin", allowed.includes("*") ? "*" : origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", MCP_CORS_ALLOW_METHODS);
  headers.set("Access-Control-Allow-Headers", MCP_CORS_ALLOW_HEADERS);
  headers.set("Access-Control-Expose-Headers", MCP_CORS_EXPOSE_HEADERS);
  return headers;
}

export function applyCorsHeaders(
  response: Response,
  request: Request,
  allowedOriginsCsv: string | undefined
): Response {
  if (!request.headers.get("origin")) return response;
  const headers = new Headers(response.headers);
  buildCorsHeaders(request, allowedOriginsCsv).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function handleCorsPreflight(request: Request, allowedOriginsCsv: string | undefined): Response {
  const originError = validateAllowedOrigin(request, allowedOriginsCsv);
  return originError ?? new Response(null, { status: 204, headers: buildCorsHeaders(request, allowedOriginsCsv) });
}

export type BoundedMcpPostFailureKind =
  | "invalid_content_length"
  | "too_large"
  | "timeout"
  | "missing_body"
  | "invalid_utf8"
  | "invalid_json"
  | "batch_unsupported"
  | "non_object_json"
  | "read_error";

export type BoundedMcpPostResult =
  | { ok: true; rawText: string; parsed: unknown }
  | { ok: false; kind: BoundedMcpPostFailureKind };

export interface ParseBoundedMcpJsonPostOptions {
  maxBytes: number;
  ingressTimeoutMs: number;
  fatalUtf8?: boolean;
  requireJsonObject?: boolean;
  requireBody?: boolean;
  rejectInvalidContentLength?: boolean;
}

export async function parseBoundedMcpJsonPost(
  request: Request,
  options: ParseBoundedMcpJsonPostOptions
): Promise<BoundedMcpPostResult> {
  const contentLengthStatus = validateContentLength(request.headers.get("content-length"), options.maxBytes);
  if (contentLengthStatus === "invalid" && options.rejectInvalidContentLength !== false) {
    cancelRequestBody(request);
    return { ok: false, kind: "invalid_content_length" };
  }
  if (contentLengthStatus === "too_large") {
    cancelRequestBody(request);
    return { ok: false, kind: "too_large" };
  }

  if (options.requireBody && !request.body) {
    return { ok: false, kind: "missing_body" };
  }

  let rawText: string;
  try {
    rawText = await readBoundedUtf8(request.body, {
      maxBytes: options.maxBytes,
      signal: request.signal,
      timeoutMs: options.ingressTimeoutMs,
      timeoutMessage: `MCP request body did not complete within ${options.ingressTimeoutMs} milliseconds.`,
      fatal: options.fatalUtf8
    });
  } catch (caught) {
    if (request.signal.aborted) {
      throw request.signal.reason ?? new DOMException("The request was aborted.", "AbortError");
    }
    if (caught instanceof BoundedBodyError) {
      if (caught.reason === "too_large") return { ok: false, kind: "too_large" };
      if (caught.reason === "timeout") return { ok: false, kind: "timeout" };
      if (caught.reason === "invalid_utf8") return { ok: false, kind: "invalid_utf8" };
      return { ok: false, kind: "read_error" };
    }
    throw caught;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, kind: "invalid_json" };
  }
  if (Array.isArray(parsed)) {
    return { ok: false, kind: "batch_unsupported" };
  }
  if (options.requireJsonObject && (!parsed || typeof parsed !== "object")) {
    return { ok: false, kind: "non_object_json" };
  }
  return { ok: true, rawText, parsed };
}
