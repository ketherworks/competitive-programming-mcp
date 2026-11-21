import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";

export const MIN_INTERNAL_KEY_LENGTH = 24;

export interface WebWorker<Env = Record<string, never>> {
  fetch(request: Request, env: Env): Promise<Response>;
}

export interface NodeHttpServerOptions<Env> {
  worker: WebWorker<Env>;
  env?: Env;
  internalKey?: string;
}

class InvalidRequestTargetError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestTargetError";
  }
}

export function createNodeHttpServer<Env = Record<string, never>>(options: NodeHttpServerOptions<Env>): Server {
  const internalKey = validateInternalKey(options.internalKey);
  const env = options.env ?? ({} as Env);

  return createServer(async (incoming, outgoing) => {
    if (internalKey && !matchesInternalKey(incoming.headers["x-oj-mcp-key"], internalKey)) {
      incoming.resume();
      sendJson(outgoing, 401, { error: "Unauthorized" });
      return;
    }

    const abort = new AbortController();
    const abortRequest = () => abort.abort(new DOMException("HTTP client disconnected.", "AbortError"));
    const abortResponse = () => {
      if (!outgoing.writableEnded) abortRequest();
    };
    incoming.once("aborted", abortRequest);
    outgoing.once("close", abortResponse);

    try {
      const request = toWebRequest(incoming, abort.signal);
      const response = await options.worker.fetch(request, env);
      if (abort.signal.aborted || outgoing.destroyed) return;
      await writeWebResponse(response, outgoing, abort.signal);
    } catch (error) {
      if (abort.signal.aborted || outgoing.destroyed) return;
      if (error instanceof InvalidRequestTargetError) {
        incoming.resume();
        sendJson(outgoing, 400, { error: error.message });
        return;
      }
      sendJson(outgoing, 500, { error: "Internal server error" });
      process.stderr.write(`OJ MCP HTTP host request failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    } finally {
      incoming.removeListener("aborted", abortRequest);
      outgoing.removeListener("close", abortResponse);
    }
  });
}

function toWebRequest(incoming: IncomingMessage, signal: AbortSignal): Request {
  const target = incoming.url ?? "/";
  if (!target.startsWith("/") || target.startsWith("//") || /[\r\n\0]/.test(target)) {
    throw new InvalidRequestTargetError("Only origin-form HTTP request targets are accepted.");
  }
  const headers = toWebHeaders(incoming.headers);
  headers.delete("x-oj-mcp-key");
  headers.delete("connection");
  headers.delete("transfer-encoding");

  const method = incoming.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  let requestUrl: string;
  try {
    requestUrl = new URL(target, "http://127.0.0.1").toString();
  } catch {
    throw new InvalidRequestTargetError("Only origin-form HTTP request targets are accepted.");
  }

  return new Request(requestUrl, {
    method,
    headers,
    signal,
    ...(hasBody
      ? {
          body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
          duplex: "half"
        }
      : {})
  } as RequestInit & { duplex?: "half" });
}

function toWebHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

async function writeWebResponse(response: Response, outgoing: ServerResponse, signal: AbortSignal): Promise<void> {
  outgoing.statusCode = response.status;
  outgoing.statusMessage = response.statusText;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  if (!response.body) {
    outgoing.end();
    return;
  }

  const reader = response.body.getReader();
  const cancel = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!outgoing.write(Buffer.from(chunk.value))) await once(outgoing, "drain");
    }
    if (!signal.aborted && !outgoing.destroyed) outgoing.end();
  } finally {
    signal.removeEventListener("abort", cancel);
    try {
      reader.releaseLock();
    } catch {
      // Cleanup must not mask the stream outcome.
    }
  }
}

export function validateInternalKey(value: string | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  if (value.length < MIN_INTERNAL_KEY_LENGTH) {
    throw new TypeError(`OJ_MCP_INTERNAL_KEY must contain at least ${MIN_INTERNAL_KEY_LENGTH} characters.`);
  }
  return Buffer.from(value, "utf8");
}

function matchesInternalKey(value: string | string[] | undefined, expected: Buffer): boolean {
  if (typeof value !== "string") return false;
  const received = Buffer.from(value, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded)
  });
  response.end(encoded);
}
