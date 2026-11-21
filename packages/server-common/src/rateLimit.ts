import { abortable, abortReason, cancelReader, releaseReader, throwIfAborted } from "./abort.js";
import { assertNonNegativeSafeInteger, assertPositiveSafeInteger, type BoundErrorConstructor } from "./bounds.js";
import { OjQueueFullError } from "./errors.js";

export type AdmissionOverloadReason = "queue_full" | "queue_timeout";

export interface AdmissionLease {
  kind: "acquired";
  release: () => void;
}

export interface AdmissionOverload {
  kind: "overloaded";
  reason: AdmissionOverloadReason;
}

export type AdmissionAcquireResult = AdmissionLease | AdmissionOverload;

export interface AdmissionControllerOptions {
  maxConcurrent: number;
  maxQueued?: number;
  queueTimeoutMs?: number;
  name?: string;
  errorCtor?: BoundErrorConstructor;
}

interface AdmissionWaiter {
  resolve: (result: AdmissionAcquireResult) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
}

export class AdmissionController {
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly queueTimeoutMs?: number;
  private readonly name: string;
  private active = 0;
  private readonly queue: AdmissionWaiter[] = [];

  constructor(options: AdmissionControllerOptions) {
    const errorCtor = options.errorCtor ?? RangeError;
    this.maxConcurrent = assertPositiveSafeInteger(options.maxConcurrent, "concurrency limit", errorCtor);
    this.maxQueued = assertNonNegativeSafeInteger(options.maxQueued ?? 0, "queue limit", errorCtor);
    this.queueTimeoutMs =
      options.queueTimeoutMs !== undefined
        ? assertPositiveSafeInteger(options.queueTimeoutMs, "queue timeout", errorCtor)
        : undefined;
    this.name = options.name ?? "OJ admission";
  }

  tryAcquire(): AdmissionLease | undefined {
    if (this.active >= this.maxConcurrent) return undefined;
    this.active += 1;
    return this.createLease();
  }

  async acquire(signal?: AbortSignal): Promise<AdmissionAcquireResult> {
    throwIfAborted(signal);
    const immediate = this.tryAcquire();
    if (immediate) return immediate;
    if (this.queue.length >= this.maxQueued) {
      return { kind: "overloaded", reason: "queue_full" };
    }

    return new Promise<AdmissionAcquireResult>((resolve, reject) => {
      const waiter: AdmissionWaiter = { resolve, reject, signal };
      if (this.queueTimeoutMs !== undefined) {
        waiter.timeout = setTimeout(() => {
          if (!this.removeWaiter(waiter)) return;
          this.cleanupWaiter(waiter);
          resolve({ kind: "overloaded", reason: "queue_timeout" });
        }, this.queueTimeoutMs);
      }
      if (signal) {
        waiter.onAbort = () => {
          if (!this.removeWaiter(waiter)) return;
          this.cleanupWaiter(waiter);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  async run<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
    options: { onOverload?: (reason: AdmissionOverloadReason) => never } = {}
  ): Promise<T> {
    const acquired = await this.acquire(signal);
    if (acquired.kind === "overloaded") {
      if (options.onOverload) options.onOverload(acquired.reason);
      throw new OjQueueFullError(
        `${this.name} ${acquired.reason === "queue_timeout" ? "queue timed out" : "queue is full"}.`,
        acquired.reason
      );
    }
    try {
      throwIfAborted(signal);
      return await operation();
    } finally {
      acquired.release();
    }
  }

  private createLease(): AdmissionLease {
    let released = false;
    return {
      kind: "acquired",
      release: () => {
        if (released) return;
        released = true;
        const next = this.queue.shift();
        if (next) {
          this.cleanupWaiter(next);
          next.resolve(this.createLease());
        } else {
          this.active -= 1;
        }
      }
    };
  }

  private removeWaiter(waiter: AdmissionWaiter): boolean {
    const index = this.queue.indexOf(waiter);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  private cleanupWaiter(waiter: AdmissionWaiter): void {
    if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
}

export function holdLeaseUntilResponseCompletes(
  response: Response,
  lease: AdmissionLease,
  signal?: AbortSignal
): Response {
  if (!response.body) {
    lease.release();
    return response;
  }

  const reader = response.body.getReader();
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    signal?.removeEventListener("abort", onAbort);
    releaseReader(reader);
    lease.release();
  };
  const onAbort = () => {
    cancelReader(reader, signal?.reason);
    finalize();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          finalize();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (caught) {
        controller.error(caught);
        finalize();
      }
    },
    cancel(reason) {
      cancelReader(reader, reason);
      finalize();
    }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export interface IntervalRateLimiterOptions {
  intervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  maxQueued?: number;
  queueTimeoutMs?: number;
  name?: string;
  onOverload?: (reason: AdmissionOverloadReason) => never;
}

export class IntervalRateLimiter {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly admission: AdmissionController;
  private readonly onOverload?: (reason: AdmissionOverloadReason) => never;
  private lastStartedAt?: number;

  constructor(options: IntervalRateLimiterOptions = {}) {
    this.intervalMs = assertNonNegativeSafeInteger(options.intervalMs ?? 2_000, "intervalMs");
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.admission = new AdmissionController({
      maxConcurrent: 1,
      maxQueued: options.maxQueued ?? 32,
      ...(options.queueTimeoutMs !== undefined ? { queueTimeoutMs: options.queueTimeoutMs } : {}),
      name: options.name ?? "OJ rate limiter"
    });
    this.onOverload = options.onOverload;
  }

  schedule<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.admission.run(
      signal,
      async () => {
        if (this.lastStartedAt !== undefined && this.intervalMs > 0) {
          const remaining = this.intervalMs - (this.now() - this.lastStartedAt);
          if (remaining > 0) {
            await abortable(this.sleep(remaining), signal);
          }
        }
        throwIfAborted(signal);
        this.lastStartedAt = this.now();
        return operation();
      },
      this.onOverload ? { onOverload: this.onOverload } : undefined
    );
  }
}

interface SharedFlight<T> {
  controller: AbortController;
  consumers: number;
  settled: boolean;
  promise: Promise<T>;
}

export interface SingleFlightOptions {
  signal?: AbortSignal;
  createCancelledError?: () => unknown;
  abortMessage?: string;
}

export class SingleFlightCoalescer<T> {
  private readonly inFlight = new Map<string, SharedFlight<T>>();

  async run(key: string, loader: (signal: AbortSignal) => Promise<T>, options: SingleFlightOptions = {}): Promise<T> {
    const cancelError = () =>
      options.createCancelledError
        ? options.createCancelledError()
        : options.signal
          ? abortReason(options.signal)
          : new DOMException("The shared read was cancelled.", "AbortError");

    if (options.signal?.aborted) {
      throw cancelError();
    }

    let shared = this.inFlight.get(key);
    if (!shared) {
      const controller = new AbortController();
      const created: SharedFlight<T> = { controller, consumers: 0, settled: false, promise: undefined as never };
      created.promise = loader(controller.signal).finally(() => {
        created.settled = true;
        if (this.inFlight.get(key) === created) this.inFlight.delete(key);
      });
      void created.promise.catch(() => undefined);
      this.inFlight.set(key, created);
      shared = created;
    }

    shared.consumers += 1;
    let removeAbortListener: (() => void) | undefined;
    try {
      if (!options.signal) return await shared.promise;
      if (options.signal.aborted) throw cancelError();
      const cancelled = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(cancelError());
        options.signal!.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal!.removeEventListener("abort", onAbort);
      });
      return await Promise.race([shared.promise, cancelled]);
    } finally {
      removeAbortListener?.();
      shared.consumers -= 1;
      if (shared.consumers === 0 && !shared.settled) {
        shared.controller.abort(
          new DOMException(options.abortMessage ?? "All shared read consumers cancelled.", "AbortError")
        );
      }
    }
  }
}
