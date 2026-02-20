/**
 * Event envelope for all Omni platform events.
 *
 * Every event flowing through the streaming layer conforms to this shape,
 * providing consistent metadata for routing, tracing, and replay.
 *
 */
export type OmniEvent = {
  id: string;
  type: string;
  subject?: string;
  source: string;
  data: Record<string, unknown>;
  timestamp: string;
  organizationId: string;
  correlationId?: string;
  schemaId?: string;
};

/**
 * Configuration for connecting to the Iggy streaming server.
 */
export type EventsConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
};

/**
 * Partial event input, omitting fields generated automatically.
 */
export type EventInput = Omit<OmniEvent, "id" | "timestamp">;

/**
 * Dead-letter queue envelope wrapping a failed event with error metadata.
 */
export type DlqEvent = {
  originalEvent: OmniEvent;
  originalTopic: string;
  error: string;
  failedAt: string;
  attemptCount: number;
};

/**
 * Callback invoked for each consumed event.
 */
export type EventHandler = (event: OmniEvent) => Promise<void>;
