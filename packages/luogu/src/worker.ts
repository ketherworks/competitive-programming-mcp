import { createOjError, type OjError } from "@kaiserunix/oj-mcp-contracts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  AdmissionController,
  applyCorsHeaders,
  assertNonNegativeSafeInteger,
  assertPositiveSafeInteger,
  cancelStream,
  handleCorsPreflight,
  hasCredentialHeaders,
  holdLeaseUntilResponseCompletes,
  jsonResponse,
  jsonRpcErrorResponse,
  parseBoundedMcpJsonPost,
  validateAllowedOrigin,
  type AdmissionAcquireResult,
  type AdmissionOverloadReason
} from "@kaiserunix/oj-mcp-server-common";
import { LuoguPageClient, LuoguUpstreamAdmissionError, type LuoguPageReader, type LuoguPageResponse } from "./client.js";
import { LuoguHealthStore, LuoguProvider } from "./provider.js";
import { createLuoguMcpServer, LUOGU_MCP_TOOL_NAMES } from "./server.js";

export interface LuoguWorkerEnv {
  LUOGU_MCP_ALLOWED_ORIGINS?: string;
}

export interface LuoguWorkerOptions {
  ingressTimeoutMs?: number;
  maxConcurrentRequests?: number;
  maxQueuedRequests?: number;
  requestQueueTimeoutMs?: number;
  maxConcurrentUpstream?: number;
  maxQueuedUpstream?: number;
  upstreamQueueTimeoutMs?: number;
}

const MCP_PATH = "/mcp";
const MAX_MCP_BODY_BYTES = 64 * 1024;
const DEFAULT_INGRESS_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 16;
const DEFAULT_MAX_QUEUED_REQUESTS = 32;
const DEFAULT_REQUEST_QUEUE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_CONCURRENT_UPSTREAM = 4;
const DEFAULT_MAX_QUEUED_UPSTREAM = 16;
const DEFAULT_UPSTREAM_QUEUE_TIMEOUT_MS = 2_000;
const OVERLOAD_RETRY_AFTER_MS = 1_000;

export function createLuoguWorker(options: LuoguWorkerOptions = {}): {
  fetch(request: Request, env: LuoguWorkerEnv): Promise<Response>;
} {
  const ingressTimeoutMs = assertPositiveSafeInteger(
    options.ingressTimeoutMs ?? DEFAULT_INGRESS_TIMEOUT_MS,
    "ingressTimeoutMs"
  );
  const requestAdmission = new AdmissionController({
    maxConcurrent: assertPositiveSafeInteger(
      options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
      "maxConcurrentRequests"
    ),
    maxQueued: assertNonNegativeSafeInteger(
      options.maxQueuedRequests ?? DEFAULT_MAX_QUEUED_REQUESTS,
      "maxQueuedRequests"
    ),
    queueTimeoutMs: assertPositiveSafeInteger(
      options.requestQueueTimeoutMs ?? DEFAULT_REQUEST_QUEUE_TIMEOUT_MS,
      "requestQueueTimeoutMs"
    ),
    name: "Luogu request"
  });
  const upstreamAdmission = new AdmissionController({
    maxConcurrent: assertPositiveSafeInteger(
      options.maxConcurrentUpstream ?? DEFAULT_MAX_CONCURRENT_UPSTREAM,
      "maxConcurrentUpstream"
    ),
    maxQueued: assertNonNegativeSafeInteger(
      options.maxQueuedUpstream ?? DEFAULT_MAX_QUEUED_UPSTREAM,
      "maxQueuedUpstream"
    ),
    queueTimeoutMs: assertPositiveSafeInteger(
      options.upstreamQueueTimeoutMs ?? DEFAULT_UPSTREAM_QUEUE_TIMEOUT_MS,
      "upstreamQueueTimeoutMs"
    ),
    name: "Luogu upstream"
  });
  const healthStore = new LuoguHealthStore();

  return {
    async fetch(request: Request, env: LuoguWorkerEnv): Promise<Response> {
      const url = new URL(request.url);
      if (hasCredentialHeaders(request)) {
        return jsonResponse({ error: "This anonymous endpoint does not accept credentials." }, 400);
      }
      if (url.pathname === "/" || url.pathname === "/healthz") {
        return jsonResponse({
          name: "luogu-mcp-server",
          transport: "streamable-http",
          state: "stateless",
          authentication: "none",
          cookies: "never accepted or forwarded",
          mcpEndpoint: MCP_PATH,
          tools: LUOGU_MCP_TOOL_NAMES
        });
      }
      if (url.pathname !== MCP_PATH) {
        return jsonResponse({ error: "Not found", mcpEndpoint: MCP_PATH }, 404);
      }

      const allowedOrigins = env.LUOGU_MCP_ALLOWED_ORIGINS;
      if (request.method === "OPTIONS") {
        return handleCorsPreflight(request, allowedOrigins);
      }
      const originError = validateAllowedOrigin(request, allowedOrigins);
      if (originError) return originError;

      let admission: AdmissionAcquireResult;
      try {
        admission = await requestAdmission.acquire(request.signal);
      } catch (caught) {
        cancelStream(request.body, caught);
        throw caught;
      }
      if (admission.kind === "overloaded") {
        cancelStream(request.body);
        return applyCorsHeaders(overloadResponse("request", admission.reason), request, allowedOrigins);
      }

      try {
        let parsedBody: unknown;
        if (request.method === "POST") {
          const parsed = await parseBoundedMcpJsonPost(request, {
            maxBytes: MAX_MCP_BODY_BYTES,
            ingressTimeoutMs,
            rejectInvalidContentLength: false
          });
          if (!parsed.ok) {
            return holdLeaseUntilResponseCompletes(
              applyCorsHeaders(mapInboundError(parsed.kind), request, allowedOrigins),
              admission,
              request.signal
            );
          }
          parsedBody = parsed.parsed;
        }

        const provider = new LuoguProvider({
          reader: new AdmittedLuoguPageReader(new LuoguPageClient(), upstreamAdmission),
          transport: "remote_http",
          healthStore
        });
        const server = createLuoguMcpServer({ provider, requestSignal: request.signal });
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        const response = applyCorsHeaders(
          await transport.handleRequest(request, { parsedBody }),
          request,
          allowedOrigins
        );
        return holdLeaseUntilResponseCompletes(response, admission, request.signal);
      } catch (caught) {
        admission.release();
        throw caught;
      }
    }
  };
}

function mapInboundError(
  kind: Exclude<Awaited<ReturnType<typeof parseBoundedMcpJsonPost>>, { ok: true }>["kind"]
): Response {
  switch (kind) {
    case "too_large":
      return jsonRpcErrorResponse(413, -32000, `MCP request body is too large; maximum is ${MAX_MCP_BODY_BYTES} bytes.`);
    case "timeout": {
      const message = "MCP request body ingress timed out.";
      return jsonRpcErrorResponse(408, -32000, message, recoverableError("network.timeout", "transport", message));
    }
    case "batch_unsupported":
      return jsonRpcErrorResponse(400, -32600, "JSON-RPC batch requests are not supported.");
    case "read_error":
      return jsonRpcErrorResponse(400, -32700, "MCP request body could not be read.");
    case "invalid_json":
    case "invalid_utf8":
    case "invalid_content_length":
    case "missing_body":
    case "non_object_json":
      return jsonRpcErrorResponse(400, -32700, "Malformed JSON request body.");
  }
}

class AdmittedLuoguPageReader implements LuoguPageReader {
  constructor(
    private readonly reader: LuoguPageReader,
    private readonly admission: AdmissionController
  ) {}

  searchProblems(options: {
    query: string;
    page: number;
    signal?: AbortSignal;
  }): Promise<LuoguPageResponse<unknown>> {
    return this.run(options.signal, () => this.reader.searchProblems(options));
  }

  fetchProblem(nativeId: string, options: { signal?: AbortSignal } = {}): Promise<LuoguPageResponse<unknown>> {
    return this.run(options.signal, () => this.reader.fetchProblem(nativeId, options));
  }

  private run<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    return this.admission.run(signal, operation, {
      onOverload: (reason) => {
        throw new LuoguUpstreamAdmissionError(reason, OVERLOAD_RETRY_AFTER_MS);
      }
    });
  }
}

function overloadResponse(scope: "request" | "upstream", reason: AdmissionOverloadReason): Response {
  const message = `Luogu ${scope} admission ${reason.replace("_", " ")}.`;
  return jsonRpcErrorResponse(503, -32000, message, recoverableError("rate_limited", "broker", message));
}

function recoverableError(code: "network.timeout" | "rate_limited", layer: "transport" | "broker", message: string): OjError {
  return createOjError({
    code,
    layer,
    message,
    retryPolicy: "safe_read",
    userAction: "retry",
    platform: "luogu",
    providerId: "luogu-lentille-page-adapter",
    retryAfterMs: OVERLOAD_RETRY_AFTER_MS
  });
}

const worker = createLuoguWorker();
export default worker;
