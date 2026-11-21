import { IntervalRateLimiter } from "@kaiserunix/oj-mcp-server-common";
import { CodeforcesQueueFullError } from "./admission.js";

export interface CodeforcesRateLimiterOptions {
  intervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  maxQueued?: number;
}

export class CodeforcesRateLimiter {
  private readonly limiter: IntervalRateLimiter;

  constructor(options: CodeforcesRateLimiterOptions = {}) {
    this.limiter = new IntervalRateLimiter({
      intervalMs: options.intervalMs ?? 2_000,
      ...(options.now ? { now: options.now } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      maxQueued: options.maxQueued ?? 32,
      name: "Codeforces client rate limiter",
      onOverload: () => {
        throw new CodeforcesQueueFullError("Codeforces client rate limiter queue is full.");
      }
    });
  }

  schedule<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.limiter.schedule(operation, signal);
  }
}
