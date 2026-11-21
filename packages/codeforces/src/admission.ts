import {
  abortable,
  AdmissionController,
  OjQueueFullError,
  throwIfAborted
} from "@kaiserunix/oj-mcp-server-common";

export { abortable, throwIfAborted };

export class CodeforcesQueueFullError extends OjQueueFullError {
  constructor(message: string) {
    super(message, "queue_full");
    this.name = "CodeforcesQueueFullError";
  }
}

export class BoundedAdmission {
  private readonly controller: AdmissionController;
  private readonly queueName: string;

  constructor(limit: number, maxQueued: number, queueName: string) {
    this.queueName = queueName;
    this.controller = new AdmissionController({
      maxConcurrent: limit,
      maxQueued,
      name: queueName
    });
  }

  run<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    return this.controller.run(signal, operation, {
      onOverload: () => {
        throw new CodeforcesQueueFullError(`${this.queueName} queue is full.`);
      }
    });
  }
}
