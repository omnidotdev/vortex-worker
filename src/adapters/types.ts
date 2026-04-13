/**
 * Event adapter interface for external event sources
 */
export interface EventAdapter {
  name: string;
  source: string;

  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(handler: (event: NormalizedEvent) => Promise<void>): void;
}

export interface NormalizedEvent {
  source: string;
  type: string;
  subject?: string;
  data: unknown;
  metadata: {
    idempotencyKey: string;
    timestamp: Date;
    raw?: unknown;
  };
}
