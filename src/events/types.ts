/**
 * Event envelope for all Omni platform events.
 *
 * Every event flowing through the streaming layer conforms to this shape,
 * providing consistent metadata for routing, tracing, and replay.
 *
 * TODO: extract to shared @omnidotdev/vortex-events package
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
 * Callback invoked for each consumed event.
 */
export type EventHandler = (event: OmniEvent) => Promise<void>;
