import type { OjErrorCode } from "@kaiserunix/oj-mcp-contracts";
import {
  assertPositiveSafeInteger,
  BoundedBodyError,
  createLinkedTimeoutSignal,
  OjAdapterError,
  OjRequestCancelledError,
  parseRetryAfterMs,
  readBoundedResponseText
} from "@kaiserunix/oj-mcp-server-common";
import type { z } from "zod";
import {
  luoguProblemIdSchema,
  luoguProblemPayloadSchema,
  luoguProblemSearchPayloadSchema,
  type LuoguProblemPayload,
  type LuoguProblemSearchPayload
} from "./upstreamSchemas.js";

const LUOGU_ORIGIN = "https://www.luogu.com.cn";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const CHALLENGE_PATTERN = /(?:captcha|challenge|cf-chl|验证码|安全验证|访问验证|云盾)/i;

// Endpoint/header compatibility is adapted from luogu-mcp-server 0.2.1; see THIRD_PARTY_NOTICES.md.

export interface LuoguPageResponse<T> {
  payload: T;
  sourceUrl: string;
}

export interface LuoguPageReader {
  searchProblems(options: { query: string; page: number; signal?: AbortSignal }): Promise<LuoguPageResponse<unknown>>;
  fetchProblem(nativeId: string, options?: { signal?: AbortSignal }): Promise<LuoguPageResponse<unknown>>;
}

export interface LuoguPageClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class LuoguAdapterError extends OjAdapterError {
  constructor(
    code: OjErrorCode,
    message: string,
    options: { httpStatus?: number; retryAfterMs?: number; cause?: unknown } = {}
  ) {
    super(code, message, options);
    this.name = "LuoguAdapterError";
  }
}

export class LuoguUpstreamAdmissionError extends LuoguAdapterError {
  constructor(reason: "queue_full" | "queue_timeout", retryAfterMs: number) {
    super("rate_limited", `Luogu upstream admission ${reason.replace("_", " ")}.`, { retryAfterMs });
    this.name = "LuoguUpstreamAdmissionError";
  }
}

export class LuoguRequestCancelledError extends OjRequestCancelledError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "LuoguRequestCancelledError";
  }
}

export class LuoguPageClient implements LuoguPageReader {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: LuoguPageClientOptions = {}) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.fetchImpl = (input, init) => fetchImpl(input, init);
    this.timeoutMs = assertPositiveSafeInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", TypeError);
    this.maxResponseBytes = assertPositiveSafeInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
      TypeError
    );
  }

  async searchProblems(options: {
    query: string;
    page: number;
    signal?: AbortSignal;
  }): Promise<LuoguPageResponse<LuoguProblemSearchPayload>> {
    const query = options.query.trim();
    if (query.length < 1 || query.length > 200) {
      throw new LuoguAdapterError("request.invalid", "Luogu search query must contain 1 to 200 characters.");
    }
    if (!Number.isInteger(options.page) || options.page < 1 || options.page > 10_000) {
      throw new LuoguAdapterError("request.invalid", "Luogu search page must be an integer from 1 to 10000.");
    }

    const url = new URL("/problem/list", LUOGU_ORIGIN);
    url.searchParams.set("type", "P");
    url.searchParams.set("keyword", query);
    if (options.page > 1) {
      url.searchParams.set("page", String(options.page));
    }
    return this.getJson(url, luoguProblemSearchPayloadSchema, "Luogu problem search", options.signal);
  }

  async fetchProblem(nativeId: string, options: { signal?: AbortSignal } = {}): Promise<LuoguPageResponse<LuoguProblemPayload>> {
    const parsed = luoguProblemIdSchema.safeParse(nativeId);
    if (!parsed.success) {
      throw new LuoguAdapterError("request.invalid", "Luogu problem id must contain 2 to 32 letters, digits, underscores, or hyphens.");
    }
    const normalizedId = parsed.data.toUpperCase();
    const url = new URL(`/problem/${encodeURIComponent(normalizedId)}`, LUOGU_ORIGIN);
    return this.getJson(url, luoguProblemPayloadSchema, "Luogu problem page", options.signal);
  }

  private async getJson<T>(
    url: URL,
    schema: z.ZodType<T>,
    label: string,
    externalSignal?: AbortSignal
  ): Promise<LuoguPageResponse<T>> {
    assertLuoguSource(url);
    const abort = createLinkedTimeoutSignal(externalSignal, this.timeoutMs, {
      timeoutMessage: "The Luogu request timed out.",
      cancelMessage: `${label} was cancelled by the caller.`
    });
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json, text/plain;q=0.9",
          Referer: `${LUOGU_ORIGIN}/`,
          "X-Lentille-Request": "content-only"
        },
        credentials: "omit",
        redirect: "error",
        signal: abort.signal
      });
    } catch (caught) {
      abort.dispose();
      if (abort.source() === "external") {
        throw new LuoguRequestCancelledError(`${label} was cancelled by the caller.`, { cause: caught });
      }
      if (caught instanceof LuoguAdapterError) {
        throw caught;
      }
      const timeout = abort.didTimeout();
      throw new LuoguAdapterError(
        timeout ? "network.timeout" : "upstream.unavailable",
        timeout ? `${label} timed out.` : `${label} could not reach Luogu.`,
        { cause: caught }
      );
    }

    try {
      const responseUrl = response.url ? new URL(response.url) : url;
      assertLuoguSource(responseUrl);

      let body: string;
      try {
        body = await readBoundedResponseText(response, {
          maxBytes: this.maxResponseBytes,
          signal: abort.signal
        });
      } catch (caught) {
        if (abort.source() === "external") {
          throw new LuoguRequestCancelledError(`${label} was cancelled by the caller.`, { cause: caught });
        }
        if (caught instanceof BoundedBodyError && caught.reason === "too_large") {
          throw new LuoguAdapterError("upstream.schema_changed", `${label} exceeded the ${this.maxResponseBytes}-byte response bound.`, {
            httpStatus: response.status
          });
        }
        throw new LuoguAdapterError(
          abort.source() === "timeout" ? "network.timeout" : "upstream.unavailable",
          `${label} response could not be read.`,
          { httpStatus: response.status, cause: caught }
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      const looksLikeHtml = contentType.includes("text/html") || /^\s*(?:<!doctype\s+html|<html\b)/i.test(body);
      if (response.status === 401 || response.status === 403 || (looksLikeHtml && CHALLENGE_PATTERN.test(body))) {
        throw new LuoguAdapterError(
          "challenge.required",
          "Luogu requires browser verification; this anonymous adapter cannot bypass or carry that challenge.",
          { httpStatus: response.status }
        );
      }
      if (response.status === 404) {
        throw new LuoguAdapterError("resource.not_found", `${label} was not found.`, { httpStatus: response.status });
      }
      if (response.status === 429) {
        throw new LuoguAdapterError("rate_limited", "Luogu rate-limited the anonymous read.", {
          httpStatus: response.status,
          retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after"), { clamp: false })
        });
      }
      if (response.status === 408) {
        throw new LuoguAdapterError("network.timeout", `${label} timed out upstream.`, { httpStatus: response.status });
      }
      if (!response.ok) {
        throw new LuoguAdapterError("upstream.unavailable", `${label} returned HTTP ${response.status}.`, {
          httpStatus: response.status
        });
      }

      if (looksLikeHtml) {
        throw new LuoguAdapterError("upstream.schema_changed", `${label} returned HTML instead of the audited JSON shape.`, {
          httpStatus: response.status
        });
      }

      let unknownPayload: unknown;
      try {
        unknownPayload = JSON.parse(body);
      } catch (caught) {
        throw new LuoguAdapterError("upstream.schema_changed", `${label} returned invalid JSON.`, {
          httpStatus: response.status,
          cause: caught
        });
      }
      const parsed = schema.safeParse(unknownPayload);
      if (!parsed.success) {
        if (CHALLENGE_PATTERN.test(body)) {
          throw new LuoguAdapterError(
            "challenge.required",
            "Luogu requires browser verification; this anonymous adapter cannot bypass or carry that challenge.",
            { httpStatus: response.status, cause: parsed.error }
          );
        }
        throw new LuoguAdapterError("upstream.schema_changed", `${label} no longer matches the audited schema.`, {
          httpStatus: response.status,
          cause: parsed.error
        });
      }
      if (abort.source() === "external") {
        throw new LuoguRequestCancelledError(`${label} was cancelled by the caller.`, { cause: externalSignal?.reason });
      }
      return { payload: parsed.data, sourceUrl: responseUrl.toString() };
    } finally {
      abort.dispose();
    }
  }
}

function assertLuoguSource(url: URL): void {
  if (url.origin !== LUOGU_ORIGIN || url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new LuoguAdapterError("policy.blocked", "Luogu adapter refused a response outside the fixed www.luogu.com.cn HTTPS origin.");
  }
}
