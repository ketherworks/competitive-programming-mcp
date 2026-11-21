import { OJ_MAX_RETRY_AFTER_MS } from "@kaiserunix/oj-mcp-contracts";
import {
  abortable,
  abortReason,
  cancelReader,
  cancelResponseBody,
  createLinkedTimeoutSignal,
  releaseReader,
  throwIfAborted
} from "./abort.js";

export type BoundedBodyErrorReason =
  | "invalid_content_length"
  | "too_large"
  | "timeout"
  | "invalid_utf8"
  | "read_error";

export class BoundedBodyError extends Error {
  readonly reason: BoundedBodyErrorReason;

  constructor(reason: BoundedBodyErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BoundedBodyError";
    this.reason = reason;
  }
}

export function parseContentLength(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function validateContentLength(value: string | null, maxBytes: number): "ok" | "invalid" | "too_large" {
  if (value === null) return "ok";
  if (!/^\d+$/.test(value)) return "invalid";
  try {
    return BigInt(value) > BigInt(maxBytes) ? "too_large" : "ok";
  } catch {
    return "invalid";
  }
}

export interface ParseRetryAfterOptions {
  maxMs?: number;
  now?: () => number;
  allowHttpDate?: boolean;
  clamp?: boolean;
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  options: ParseRetryAfterOptions = {}
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const maxMs = options.maxMs ?? OJ_MAX_RETRY_AFTER_MS;
  const clamp = options.clamp ?? true;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return undefined;
    const ms = seconds * 1_000;
    if (ms > maxMs) return clamp ? maxMs : undefined;
    return ms;
  }
  if (options.allowHttpDate === false) return undefined;
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  const now = options.now ?? Date.now;
  const delay = timestamp - now();
  if (delay < 0) return clamp ? 0 : undefined;
  if (delay > maxMs) return clamp ? maxMs : undefined;
  return delay;
}

export interface ReadBoundedBytesOptions {
  maxBytes: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutMessage?: string;
}

export async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  options: ReadBoundedBytesOptions
): Promise<Uint8Array> {
  throwIfAborted(options.signal);
  if (!body) return new Uint8Array();

  const linked =
    options.timeoutMs !== undefined
      ? createLinkedTimeoutSignal(options.signal, options.timeoutMs, {
          timeoutMessage: options.timeoutMessage ?? `Body did not complete within ${options.timeoutMs} milliseconds.`
        })
      : undefined;
  const activeSignal = linked?.signal ?? options.signal;
  const reader = body.getReader();
  const onAbort = () => cancelReader(reader, activeSignal?.reason);
  activeSignal?.addEventListener("abort", onAbort, { once: true });

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      throwIfAborted(options.signal);
      if (linked?.didTimeout()) {
        cancelReader(reader, activeSignal?.reason);
        throw new BoundedBodyError(
          "timeout",
          options.timeoutMessage ?? `Body did not complete within ${options.timeoutMs} milliseconds.`
        );
      }
      const { done, value } = await abortable(reader.read(), activeSignal);
      if (options.signal?.aborted) {
        cancelReader(reader, options.signal.reason);
        throw abortReason(options.signal);
      }
      if (linked?.didTimeout()) {
        cancelReader(reader, activeSignal?.reason);
        throw new BoundedBodyError(
          "timeout",
          options.timeoutMessage ?? `Body did not complete within ${options.timeoutMs} milliseconds.`
        );
      }
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > options.maxBytes) {
        cancelReader(reader);
        throw new BoundedBodyError("too_large", `Body exceeded the ${options.maxBytes}-byte limit.`);
      }
      chunks.push(value);
    }
  } catch (caught) {
    if (caught instanceof BoundedBodyError) throw caught;
    cancelReader(reader, caught);
    if (options.signal?.aborted) {
      throw abortReason(options.signal);
    }
    if (linked?.didTimeout()) {
      throw new BoundedBodyError(
        "timeout",
        options.timeoutMessage ?? `Body did not complete within ${options.timeoutMs} milliseconds.`,
        { cause: caught }
      );
    }
    throw new BoundedBodyError("read_error", "Stream body could not be read.", { cause: caught });
  } finally {
    linked?.dispose();
    activeSignal?.removeEventListener("abort", onAbort);
    releaseReader(reader);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export interface ReadBoundedUtf8Options extends ReadBoundedBytesOptions {
  fatal?: boolean;
}

export async function readBoundedUtf8(
  body: ReadableStream<Uint8Array> | null,
  options: ReadBoundedUtf8Options
): Promise<string> {
  const bytes = await readBoundedBytes(body, options);
  try {
    return new TextDecoder("utf-8", { fatal: options.fatal ?? false }).decode(bytes);
  } catch (caught) {
    throw new BoundedBodyError("invalid_utf8", "Body was not valid UTF-8.", { cause: caught });
  }
}

export interface ReadBoundedResponseTextOptions extends ReadBoundedUtf8Options {
  checkDeclaredLength?: boolean;
}

export async function readBoundedResponseText(
  response: Response,
  options: ReadBoundedResponseTextOptions
): Promise<string> {
  if (options.checkDeclaredLength !== false) {
    const contentLength = response.headers.get("content-length");
    if (validateContentLength(contentLength, options.maxBytes) === "too_large") {
      cancelResponseBody(response);
      throw new BoundedBodyError("too_large", `Response exceeded the ${options.maxBytes}-byte limit.`);
    }
  }
  return readBoundedUtf8(response.body, options);
}
