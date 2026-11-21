import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  AdmissionController,
  applyCorsHeaders,
  assertPositiveSafeInteger,
  cancelRequestBody,
  handleCorsPreflight,
  hasCredentialHeaders,
  jsonResponse,
  parseBoundedMcpJsonPost,
  validateAllowedOrigin
} from "@kaiserunix/oj-mcp-server-common";
import { AtCoderHtmlClient } from "./client.js";
import { AtCoderProvider } from "./provider.js";
import { ATCODER_MCP_TOOL_NAMES, createAtCoderMcpServer } from "./server.js";

export interface AtCoderWorkerEnv {
  ATCODER_MCP_ALLOWED_ORIGINS?: string;
}

export interface AtCoderWorkerOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  nowIso?: () => string;
  maxInboundBytes?: number;
  maxConcurrentRequests?: number;
  ingressTimeoutMs?: number;
}

export interface AtCoderWorker {
  fetch(request: Request, env: AtCoderWorkerEnv): Promise<Response>;
}

const MCP_PATH = "/mcp";
const DEFAULT_MAX_INBOUND_BYTES = 64 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
const DEFAULT_INGRESS_TIMEOUT_MS = 10_000;

export function createAtCoderWorker(options: AtCoderWorkerOptions = {}): AtCoderWorker {
  const maxInboundBytes = assertPositiveSafeInteger(
    options.maxInboundBytes ?? DEFAULT_MAX_INBOUND_BYTES,
    "maxInboundBytes",
    TypeError
  );
  const ingressTimeoutMs = assertPositiveSafeInteger(
    options.ingressTimeoutMs ?? DEFAULT_INGRESS_TIMEOUT_MS,
    "ingressTimeoutMs",
    TypeError
  );
  const admission = new AdmissionController({
    maxConcurrent: assertPositiveSafeInteger(
      options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
      "maxConcurrentRequests",
      TypeError
    ),
    maxQueued: 0,
    name: "AtCoder MCP",
    errorCtor: TypeError
  });
  const provider = new AtCoderProvider({
    client: new AtCoderHtmlClient({ ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.nowIso ? { nowIso: options.nowIso } : {})
  });

  return {
    async fetch(request: Request, env: AtCoderWorkerEnv): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/" || url.pathname === "/healthz") {
        return jsonResponse({
          name: "atcoder-mcp-server",
          transport: "streamable-http",
          stateless: true,
          mcpEndpoint: MCP_PATH,
          authentication: "none",
          tools: ATCODER_MCP_TOOL_NAMES
        });
      }
      if (url.pathname !== MCP_PATH) return jsonResponse({ error: "Not found", mcpEndpoint: MCP_PATH }, 404);

      const allowedOrigins = env.ATCODER_MCP_ALLOWED_ORIGINS;
      if (request.method === "OPTIONS") return handleCorsPreflight(request, allowedOrigins);
      const originError = validateAllowedOrigin(request, allowedOrigins);
      if (originError) return originError;

      const lease = admission.tryAcquire();
      if (!lease) {
        cancelRequestBody(request);
        return applyCorsHeaders(
          jsonResponse({ error: "AtCoder MCP request capacity is full." }, 503),
          request,
          allowedOrigins
        );
      }

      let transport: WebStandardStreamableHTTPServerTransport | undefined;
      let server: ReturnType<typeof createAtCoderMcpServer> | undefined;
      try {
        if (hasCredentialHeaders(request)) {
          cancelRequestBody(request);
          return applyCorsHeaders(
            jsonResponse({ error: "Authentication headers are not accepted." }, 400),
            request,
            allowedOrigins
          );
        }
        const prepared =
          request.method === "POST"
            ? await prepareBoundedPost(request, maxInboundBytes, ingressTimeoutMs)
            : request;
        if (prepared instanceof Response) return applyCorsHeaders(prepared, request, allowedOrigins);

        transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true
        });
        server = createAtCoderMcpServer({ provider, transport: "remote_http" });
        await server.connect(transport);
        return applyCorsHeaders(await transport.handleRequest(prepared), request, allowedOrigins);
      } finally {
        try {
          if (server) await server.close();
          else await transport?.close();
        } finally {
          lease.release();
        }
      }
    }
  };
}

async function prepareBoundedPost(
  request: Request,
  maximumBytes: number,
  ingressTimeoutMs: number
): Promise<Request | Response> {
  const result = await parseBoundedMcpJsonPost(request, {
    maxBytes: maximumBytes,
    ingressTimeoutMs,
    fatalUtf8: true,
    requireJsonObject: true
  });
  if (!result.ok) {
    switch (result.kind) {
      case "invalid_content_length":
        return jsonResponse({ error: "Invalid Content-Length." }, 400);
      case "too_large":
        return jsonResponse({ error: "MCP request body is too large." }, 413);
      case "timeout":
        return jsonResponse(
          { error: `MCP request body did not complete within ${ingressTimeoutMs} milliseconds.` },
          408
        );
      case "invalid_utf8":
        return jsonResponse({ error: "MCP request body must be valid UTF-8." }, 400);
      case "invalid_json":
      case "read_error":
      case "missing_body":
        return jsonResponse({ error: "MCP request body must be valid JSON." }, 400);
      case "batch_unsupported":
        return jsonResponse({ error: "JSON-RPC batches are not supported." }, 400);
      case "non_object_json":
        return jsonResponse({ error: "MCP request body must be a JSON object." }, 400);
    }
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: result.rawText,
    signal: request.signal
  });
}

const worker = createAtCoderWorker();
export default worker;
