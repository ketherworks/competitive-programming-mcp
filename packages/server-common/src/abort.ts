export interface CombinedAbortSignal {
  signal: AbortSignal;
  dispose: () => void;
}

export interface LinkedTimeoutSignal extends CombinedAbortSignal {
  didTimeout: () => boolean;
  source: () => "external" | "timeout" | undefined;
}

export function abortReason(signal: AbortSignal, fallbackMessage = "The operation was aborted."): unknown {
  return signal.reason ?? new DOMException(fallbackMessage, "AbortError");
}

export function throwIfAborted(signal?: AbortSignal, fallbackMessage?: string): void {
  if (signal?.aborted) {
    throw abortReason(signal, fallbackMessage);
  }
}

export function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  fallbackMessage = "The operation was aborted."
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal, fallbackMessage));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortReason(signal, fallbackMessage)));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): CombinedAbortSignal {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (activeSignals.length === 1) {
    return { signal: activeSignals[0]!, dispose: () => undefined };
  }
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const signal of activeSignals) {
    const listener = () => controller.abort(abortReason(signal));
    if (signal.aborted) {
      listener();
      break;
    }
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const item of listeners) {
        item.signal.removeEventListener("abort", item.listener);
      }
    }
  };
}

export function createLinkedTimeoutSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
  options: { timeoutMessage?: string; cancelMessage?: string } = {}
): LinkedTimeoutSignal {
  const controller = new AbortController();
  let source: "external" | "timeout" | undefined;
  const cancelMessage = options.cancelMessage ?? "The request was cancelled.";
  const timeoutMessage = options.timeoutMessage ?? "The request timed out.";

  const onExternalAbort = () => {
    if (source) return;
    source = "external";
    controller.abort(externalSignal ? abortReason(externalSignal, cancelMessage) : new DOMException(cancelMessage, "AbortError"));
  };
  if (externalSignal?.aborted) {
    onExternalAbort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  const timer = setTimeout(() => {
    if (source) return;
    source = "timeout";
    controller.abort(new DOMException(timeoutMessage, "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => source === "timeout",
    source: () => source,
    dispose: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  };
}

export function cancelBestEffort(cancel: () => Promise<void>): void {
  try {
    void cancel().catch(() => {
      // Cleanup must not replace the authoritative response or cancellation reason.
    });
  } catch {
    // Cleanup must not replace the authoritative response or cancellation reason.
  }
}

export function cancelStream(body: ReadableStream<Uint8Array> | null | undefined, reason?: unknown): void {
  if (!body || body.locked) return;
  cancelBestEffort(() => body.cancel(reason));
}

export function cancelRequestBody(request: Request, reason?: unknown): void {
  cancelStream(request.body, reason);
}

export function cancelResponseBody(response: Response, reason?: unknown): void {
  cancelStream(response.body, reason);
}

export function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  cancelBestEffort(() => reader.cancel(reason));
}

export function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // Cleanup must not replace the authoritative response or cancellation reason.
  }
}
