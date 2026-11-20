export interface HealthObservation<TError> {
  sequence: number;
  checkedAt: string;
  latencyMs?: number;
  error?: TError;
}

export class MonotonicHealthStore<TError> {
  private nextSequence = 0;
  private committedSequence = 0;
  private observation?: HealthObservation<TError>;

  begin(): number {
    this.nextSequence += 1;
    return this.nextSequence;
  }

  recordSuccess(sequence: number, checkedAt: string, latencyMs?: number): void {
    this.commit({
      sequence,
      checkedAt,
      ...(latencyMs !== undefined ? { latencyMs: Math.max(0, latencyMs) } : {})
    });
  }

  recordError(sequence: number, checkedAt: string, error: TError, latencyMs?: number): void {
    this.commit({
      sequence,
      checkedAt,
      error,
      ...(latencyMs !== undefined ? { latencyMs: Math.max(0, latencyMs) } : {})
    });
  }

  snapshot(): HealthObservation<TError> | undefined {
    return this.observation;
  }

  private commit(observation: HealthObservation<TError>): void {
    if (observation.sequence >= this.committedSequence) {
      this.committedSequence = observation.sequence;
      this.observation = observation;
    }
  }
}
