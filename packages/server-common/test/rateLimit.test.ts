import { describe, expect, test, vi } from "vitest";
import {
  AdmissionController,
  holdLeaseUntilResponseCompletes,
  IntervalRateLimiter,
  OjQueueFullError,
  SingleFlightCoalescer
} from "../src/index.js";

describe("AdmissionController", () => {
  test("validates constructor bounds", () => {
    expect(() => new AdmissionController({ maxConcurrent: 0 })).toThrow(RangeError);
    expect(() => new AdmissionController({ maxConcurrent: 1, maxQueued: -1 })).toThrow(RangeError);
    expect(() => new AdmissionController({ maxConcurrent: 1, queueTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new AdmissionController({ maxConcurrent: 0, errorCtor: TypeError })).toThrow(TypeError);
  });

  test("handles idempotent double-release, FIFO handoff, queue full, and aborted waiter removal", async () => {
    const admission = new AdmissionController({ maxConcurrent: 1, maxQueued: 1, name: "Test" });
    const first = admission.tryAcquire();
    expect(first).toBeDefined();
    expect(admission.tryAcquire()).toBeUndefined();

    const waiterAbort = new AbortController();
    const queued = admission.acquire(waiterAbort.signal);

    // Queue is now full.
    await expect(admission.acquire()).resolves.toEqual({ kind: "overloaded", reason: "queue_full" });

    // Abort the queued waiter; a replacement waiter should now fit.
    waiterAbort.abort(new DOMException("cancelled", "AbortError"));
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });

    const replacement = admission.acquire();
    // Double release must only free a single slot.
    first!.release();
    first!.release();

    const acquired = await replacement;
    expect(acquired.kind).toBe("acquired");
    expect(admission.tryAcquire()).toBeUndefined();
    if (acquired.kind === "acquired") acquired.release();
    const next = admission.tryAcquire();
    expect(next).toBeDefined();
    next!.release();
  });

  test("resolves queue_timeout with fake timers and cleans up waiter state", async () => {
    vi.useFakeTimers();
    try {
      const admission = new AdmissionController({
        maxConcurrent: 1,
        maxQueued: 1,
        queueTimeoutMs: 50
      });
      const lease = admission.tryAcquire()!;
      const pending = admission.acquire();

      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toEqual({ kind: "overloaded", reason: "queue_timeout" });

      lease.release();
      const fresh = admission.tryAcquire();
      expect(fresh).toBeDefined();
      fresh!.release();
    } finally {
      vi.useRealTimers();
    }
  });

  test("run throws OjQueueFullError by default and supports custom onOverload", async () => {
    const admission = new AdmissionController({ maxConcurrent: 1, maxQueued: 0, name: "Worker" });
    const lease = admission.tryAcquire()!;

    await expect(admission.run(undefined, async () => "ok")).rejects.toBeInstanceOf(OjQueueFullError);
    await expect(
      admission.run(undefined, async () => "ok", {
        onOverload: (reason) => {
          throw new Error(`custom:${reason}`);
        }
      })
    ).rejects.toThrow("custom:queue_full");
    lease.release();
  });

  test("holdLeaseUntilResponseCompletes holds admission until stream completion, cancellation, or abort", async () => {
    const admission = new AdmissionController({ maxConcurrent: 1, maxQueued: 0 });

    // Bodyless response releases immediately.
    const bodylessLease = admission.tryAcquire()!;
    holdLeaseUntilResponseCompletes(new Response(null, { status: 204 }), bodylessLease);
    const reacquired = admission.tryAcquire();
    expect(reacquired).toBeDefined();

    // Streaming response holds lease until reader completes.
    let enqueue!: (chunk: Uint8Array) => void;
    let close!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        enqueue = (chunk) => controller.enqueue(chunk);
        close = () => controller.close();
      }
    });
    const held = holdLeaseUntilResponseCompletes(new Response(stream), reacquired!);
    expect(admission.tryAcquire()).toBeUndefined();

    const textPromise = held.text();
    enqueue(new TextEncoder().encode("hello"));
    expect(admission.tryAcquire()).toBeUndefined();
    close();
    await expect(textPromise).resolves.toBe("hello");

    const afterClose = admission.tryAcquire();
    expect(afterClose).toBeDefined();

    // Abort releases lease and cancels underlying stream.
    let cancelled = false;
    const abortController = new AbortController();
    const stalled = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      }
    });
    holdLeaseUntilResponseCompletes(new Response(stalled), afterClose!, abortController.signal);
    expect(admission.tryAcquire()).toBeUndefined();
    abortController.abort(new DOMException("disconnect", "AbortError"));
    expect(cancelled).toBe(true);
    const afterAbort = admission.tryAcquire();
    expect(afterAbort).toBeDefined();
    afterAbort!.release();
  });
});

describe("IntervalRateLimiter", () => {
  test("serializes operations with interval pacing and aborts cleanly while sleeping", async () => {
    let now = 100;
    const sleeps: number[] = [];
    let releaseSleep!: () => void;
    const limiter = new IntervalRateLimiter({
      intervalMs: 1_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 1) {
          await new Promise<void>((resolve) => {
            releaseSleep = resolve;
          });
        }
        now += ms;
      }
    });

    const first = await limiter.schedule(async () => "first");
    expect(first).toBe("first");

    const abort = new AbortController();
    const sleepingCall = limiter.schedule(async () => "never", abort.signal);
    await Promise.resolve();
    abort.abort(new DOMException("abort sleep", "AbortError"));
    await expect(sleepingCall).rejects.toMatchObject({ name: "AbortError" });
    releaseSleep();

    now = 2_000;
    await expect(limiter.schedule(async () => "second")).resolves.toBe("second");
  });
});

describe("SingleFlightCoalescer", () => {
  test("coalesces concurrent loads, keeps upstream alive when one consumer cancels, and aborts only when all cancel", async () => {
    const coalescer = new SingleFlightCoalescer<string>();
    let loaderCalls = 0;
    let upstreamSignal: AbortSignal | undefined;
    let resolveLoad!: (value: string) => void;

    const loader = (signal: AbortSignal) => {
      loaderCalls += 1;
      upstreamSignal = signal;
      return new Promise<string>((resolve, reject) => {
        resolveLoad = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };

    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = coalescer.run("task-1", loader, { signal: firstAbort.signal });
    const second = coalescer.run("task-1", loader, { signal: secondAbort.signal });
    expect(loaderCalls).toBe(1);

    firstAbort.abort(new DOMException("first left", "AbortError"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(upstreamSignal?.aborted).toBe(false);

    resolveLoad("payload");
    await expect(second).resolves.toBe("payload");

    // Next call after settlement triggers a fresh load; aborting the only consumer aborts upstream.
    const soloAbort = new AbortController();
    const solo = coalescer.run("task-1", loader, { signal: soloAbort.signal });
    expect(loaderCalls).toBe(2);
    soloAbort.abort(new DOMException("solo left", "AbortError"));
    await expect(solo).rejects.toMatchObject({ name: "AbortError" });
    expect(upstreamSignal?.aborted).toBe(true);
  });

  test("rejects immediately when signal is already aborted without starting upstream", async () => {
    const coalescer = new SingleFlightCoalescer<string>();
    let called = false;
    const preAborted = new AbortController();
    preAborted.abort(new DOMException("pre-aborted", "AbortError"));

    await expect(
      coalescer.run(
        "task-2",
        async () => {
          called = true;
          return "ok";
        },
        { signal: preAborted.signal }
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(called).toBe(false);
  });
});
