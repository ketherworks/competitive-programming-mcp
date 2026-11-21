import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  applyCorsHeaders,
  assertSafeIntegerInRange,
  cancelRequestBody,
  cancelResponseBody,
  createLinkedTimeoutSignal,
  handleCorsPreflight,
  hasCredentialHeaders,
  jsonResponse,
  jsonRpcErrorResponse,
  parseBoundedMcpJsonPost,
  validateAllowedOrigin
} from "@kaiserunix/oj-mcp-server-common";
import { BoundedAdmission, CodeforcesQueueFullError } from "./admission.js";
import { CodeforcesApiClient } from "./client.js";
import {
  CodeforcesCoordinator,
  codeforcesUpstreamHealthObservationSchema,
  type CodeforcesUpstreamHealthObservation
} from "./coordinator.js";
import { CodeforcesProvider } from "./provider.js";
import { CodeforcesRateLimiter } from "./rateLimiter.js";
import { CODEFORCES_MCP_TOOL_NAMES, createCodeforcesMcpServer } from "./server.js";

interface CoordinatorStub {
  fetch(request: Request): Promise<Response>;
}

interface CoordinatorNamespace {
  getByName(name: string): CoordinatorStub;
}

export interface CodeforcesWorkerEnv {
  CODEFORCES_COORDINATOR?: CoordinatorNamespace;
  CODEFORCES_MCP_ALLOWED_ORIGINS?: string;
}

export interface CodeforcesWorkerOptions {
  maxRequestBytes?: number;
  maxConcurrentRequests?: number;
  maxQueuedRequests?: number;
  upstreamTimeoutMs?: number;
  ingressTimeoutMs?: number;
}

const MCP_PATH = "/mcp";
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;

export function createCodeforcesWorker(options: CodeforcesWorkerOptions = {}): {
  fetch(request: Request, env: CodeforcesWorkerEnv): Promise<Response>;
} {
  const maxRequestBytes = assertSafeIntegerInRange(
    options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    1,
    8 * 1024 * 1024,
    "maxRequestBytes"
  );
  const upstreamTimeoutMs = assertSafeIntegerInRange(options.upstreamTimeoutMs ?? 15_000, 1, 120_000, "upstreamTimeoutMs");
  const ingressTimeoutMs = assertSafeIntegerInRange(options.ingressTimeoutMs ?? 10_000, 1, 120_000, "ingressTimeoutMs");
  const admission = new BoundedAdmission(
    options.maxConcurrentRequests ?? 8,
    options.maxQueuedRequests ?? 32,
    "Codeforces Worker"
  );

  return {
    async fetch(request: Request, env: CodeforcesWorkerEnv): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/" || url.pathname === "/healthz") {
        return respondBeforeBodyRead(
          request,
          jsonResponse({
            name: "codeforces-mcp-server",
            transport: "streamable-http",
            mcpEndpoint: MCP_PATH,
            authentication: "none",
            tools: CODEFORCES_MCP_TOOL_NAMES
          })
        );
      }
      if (url.pathname !== MCP_PATH) {
        return respondBeforeBodyRead(request, jsonResponse({ error: "Not found", mcpEndpoint: MCP_PATH }, 404));
      }

      const allowedOrigins = env.CODEFORCES_MCP_ALLOWED_ORIGINS;
      if (request.method === "OPTIONS") {
        return respondBeforeBodyRead(request, handleCorsPreflight(request, allowedOrigins));
      }
      const originError = validateAllowedOrigin(request, allowedOrigins);
      if (originError) return respondBeforeBodyRead(request, originError);
      if (hasCredentialHeaders(request)) {
        return respondBeforeBodyRead(
          request,
          applyCorsHeaders(jsonResponse({ error: "Credential-bearing requests are not accepted." }, 400), request, allowedOrigins)
        );
      }

      try {
        return await admission.run(request.signal, () =>
          handleMcpRequest(request, env, maxRequestBytes, upstreamTimeoutMs, ingressTimeoutMs)
        );
      } catch (error) {
        if (error instanceof CodeforcesQueueFullError) {
          cancelRequestBody(request);
          return applyCorsHeaders(
            jsonResponse({ error: error.message, retryAfterMs: 2_000 }, 429, { "Retry-After": "2" }),
            request,
            allowedOrigins
          );
        }
        throw error;
      }
    }
  };
}

const worker = createCodeforcesWorker();

export { CodeforcesCoordinator };
export default worker;

async function handleMcpRequest(
  request: Request,
  env: CodeforcesWorkerEnv,
  maxRequestBytes: number,
  upstreamTimeoutMs: number,
  ingressTimeoutMs: number
): Promise<Response> {
  const allowedOrigins = env.CODEFORCES_MCP_ALLOWED_ORIGINS;
  let parsedBody: unknown;
  if (request.method === "POST") {
    const parsed = await parseBoundedMcpJsonPost(request, {
      maxBytes: maxRequestBytes,
      ingressTimeoutMs,
      requireBody: true
    });
    if (!parsed.ok) {
      return applyCorsHeaders(
        mapInboundError(parsed.kind, maxRequestBytes, ingressTimeoutMs),
        request,
        allowedOrigins
      );
    }
    parsedBody = parsed.parsed;
  }

  const stub = coordinatorStub(env);
  const provider = new CodeforcesProvider({
    client: new CodeforcesApiClient({
      limiter: new CodeforcesRateLimiter({ intervalMs: 0 }),
      timeoutMs: upstreamTimeoutMs,
      fetchImpl: async (_input, init) =>
        stub.fetch(new Request("https://coordinator/problemset.problems", { signal: init?.signal }))
    }),
    healthReader: async ({ signal } = {}) => readCoordinatorHealth(stub, signal, upstreamTimeoutMs)
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createCodeforcesMcpServer({ provider, transport: "remote_http" });
  await server.connect(transport);
  return applyCorsHeaders(await transport.handleRequest(request, { parsedBody }), request, allowedOrigins);
}

function mapInboundError(
  kind: Exclude<Awaited<ReturnType<typeof parseBoundedMcpJsonPost>>, { ok: true }>["kind"],
  maxRequestBytes: number,
  ingressTimeoutMs: number
): Response {
  switch (kind) {
    case "invalid_content_length":
      return jsonResponse({ error: "Invalid Content-Length." }, 400);
    case "too_large":
      return jsonResponse({ error: `MCP request body exceeds ${maxRequestBytes} bytes.` }, 413);
    case "timeout":
      return jsonResponse(
        { error: `MCP request body did not complete within ${ingressTimeoutMs} milliseconds.` },
        408
      );
    case "missing_body":
      return jsonResponse({ error: "MCP POST request body is required." }, 400);
    case "invalid_json":
    case "invalid_utf8":
      return jsonResponse({ error: "MCP request body must be valid JSON." }, 400);
    case "batch_unsupported":
      return jsonRpcErrorResponse(400, -32600, "JSON-RPC batch requests are not supported.");
    case "non_object_json":
    case "read_error":
      return jsonResponse({ error: "Invalid request body." }, 400);
  }
}

function coordinatorStub(env: CodeforcesWorkerEnv): CoordinatorStub {
  const namespace = env.CODEFORCES_COORDINATOR;
  if (!namespace) {
    return {
      fetch: async () => {
        throw new Error("CODEFORCES_COORDINATOR binding is unavailable.");
      }
    };
  }
  return namespace.getByName("codeforces-official-api-v1");
}

async function readCoordinatorHealth(
  stub: CoordinatorStub,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<CodeforcesUpstreamHealthObservation | undefined> {
  const abort = createLinkedTimeoutSignal(signal, timeoutMs, {
    timeoutMessage: "Codeforces coordinator health request timed out."
  });
  try {
    const response = await stub.fetch(new Request("https://coordinator/health", { signal: abort.signal }));
    if (!response.ok) {
      cancelResponseBody(response);
      return undefined;
    }
    const parsed = codeforcesUpstreamHealthObservationSchema.nullable().safeParse(await response.json());
    return parsed.success ? parsed.data ?? undefined : undefined;
  } finally {
    abort.dispose();
  }
}

function respondBeforeBodyRead(request: Request, response: Response): Response {
  cancelRequestBody(request);
  return response;
}
