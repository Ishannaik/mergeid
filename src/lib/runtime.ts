/** A booted runtime role. `stop()` must be idempotent and must not throw. */
export interface RuntimeRole {
  readonly name: 'bot' | 'api' | 'worker';
  stop(): Promise<void>;
}
