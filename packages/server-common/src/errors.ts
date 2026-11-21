import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createOjError,
  sanitizeHttpStatus,
  sanitizeRetryAfterMs,
  type OjError,
  type OjErrorCode,
  type OjPlatformId
} from "@kaiserunix/oj-mcp-contracts";

export interface OjAdapterErrorOptions {
  httpStatus?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

export class OjAdapterError extends Error {
  readonly code: OjErrorCode;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;

  constructor(code: OjErrorCode, message: string, options: OjAdapterErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "OjAdapterError";
    this.code = code;
    this.httpStatus = sanitizeHttpStatus(options.httpStatus);
    this.retryAfterMs = sanitizeRetryAfterMs(options.retryAfterMs);
  }
}

export class OjRequestCancelledError extends Error {
  constructor(message = "The OJ request was cancelled.", options?: ErrorOptions) {
    super(message, options);
    this.name = "OjRequestCancelledError";
  }
}

export class OjQueueFullError extends Error {
  readonly reason: "queue_full" | "queue_timeout";

  constructor(message: string, reason: "queue_full" | "queue_timeout" = "queue_full") {
    super(message);
    this.name = "OjQueueFullError";
    this.reason = reason;
  }
}

export interface OjErrorNormalizerOptions {
  platform: OjPlatformId;
  providerId: string;
  internalMessage: string;
  fallbackMessage?: string;
  resolveLayer?: (error: OjAdapterError) => OjError["layer"];
  resolveRetryPolicy?: (error: OjAdapterError) => OjError["retryPolicy"];
  resolveUserAction?: (error: OjAdapterError) => OjError["userAction"];
  mapUnknownError?: (caught: unknown, requestId?: string) => OjError | undefined;
}

export function normalizeOjError(
  caught: unknown,
  options: OjErrorNormalizerOptions,
  requestId?: string
): OjError {
  if (caught instanceof OjAdapterError) {
    try {
      return createOjError({
        code: caught.code,
        message: caught.message,
        platform: options.platform,
        providerId: options.providerId,
        ...(options.resolveLayer ? { layer: options.resolveLayer(caught) } : {}),
        ...(options.resolveRetryPolicy ? { retryPolicy: options.resolveRetryPolicy(caught) } : {}),
        ...(options.resolveUserAction ? { userAction: options.resolveUserAction(caught) } : {}),
        httpStatus: caught.httpStatus,
        retryAfterMs: caught.retryAfterMs,
        requestId,
        fallbackMessage: options.fallbackMessage
      });
    } catch {
      return createOjError({
        code: "internal",
        layer: "broker",
        message: options.fallbackMessage ?? options.internalMessage,
        retryPolicy: "never",
        userAction: "open_logs",
        platform: options.platform,
        providerId: options.providerId,
        requestId
      });
    }
  }

  const mapped = options.mapUnknownError?.(caught, requestId);
  if (mapped) return mapped;

  return createOjError({
    code: "internal",
    layer: "broker",
    message: options.internalMessage,
    retryPolicy: "never",
    userAction: "open_logs",
    platform: options.platform,
    providerId: options.providerId,
    requestId,
    fallbackMessage: options.fallbackMessage
  });
}

export function toNormalizedToolError(
  caught: unknown,
  options: OjErrorNormalizerOptions,
  requestId?: string
): CallToolResult {
  const error = normalizeOjError(caught, options, requestId);
  return {
    isError: true,
    content: [{ type: "text", text: error.message }],
    structuredContent: error as unknown as Record<string, unknown>
  };
}

export function isTimeoutError(error: unknown, options: { includeAbortError?: boolean } = {}): boolean {
  if (!error || typeof error !== "object") return false;
  const includeAbortError = options.includeAbortError ?? true;
  const candidate = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
  return (
    candidate.name === "TimeoutError" ||
    (includeAbortError && candidate.name === "AbortError") ||
    candidate.code === "ETIMEDOUT" ||
    candidate.code === "UND_ERR_CONNECT_TIMEOUT" ||
    candidate.cause?.code === "ETIMEDOUT" ||
    candidate.cause?.code === "UND_ERR_CONNECT_TIMEOUT"
  );
}
