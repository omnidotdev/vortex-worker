/**
 * CloudEvents v1.0 envelope for all Omni platform events.
 *
 * Every event flowing through the streaming layer conforms to this shape,
 * providing consistent metadata for routing, tracing, and replay.
 *
 * @see https://cloudevents.io/
 */
export type OmniEvent = {
  /** CloudEvents spec version */
  specversion?: string;
  id: string;
  type: string;
  subject?: string;
  source: string;
  /** MIME type of `data` */
  datacontenttype?: string;
  /** URI to the event's JSON Schema definition in the registry */
  dataschema?: string;
  data: Record<string, unknown>;
  /** ISO 8601 timestamp */
  time?: string;
  /** @deprecated Use `time` instead (CloudEvents naming) */
  timestamp: string;
  organizationId: string;
  correlationId?: string;
  /**
   * Idempotency key identifying a single logical delivery. Used for
   * deduplication; unlike `correlationId` it is NOT shared across related
   * events. Absent for producers that do not set one (dedup then falls back
   * to the unique event `id`).
   */
  idempotencyKey?: string;
  /** @deprecated Use `dataschema` instead */
  schemaId?: string;
  /** W3C Trace Context for distributed tracing */
  traceContext?: {
    traceparent?: string;
    tracestate?: string;
  };
  // -- Omni CloudEvents extension attributes --
  /** Organization ID (Omni extension) */
  omniorgid?: string;
  /** Workspace ID (Omni extension) */
  omniworkspaceid?: string;
  /** Event schema version (Omni extension) */
  omnischemaversion?: number;
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
export type EventInput = Omit<OmniEvent, "id" | "timestamp" | "time">;

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
