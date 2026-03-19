/**
 * Circuit breaker for connector integrations
 *
 * Prevents cascading failures by tracking connector error rates
 * and temporarily blocking requests to failing services.
 * Uses Redis for distributed state when available, otherwise
 * acts as a no-op passthrough.
 */

import { cacheClient } from "lib/cache/client";
import { IntegrationError } from "lib/errors";
import logger from "lib/logger";

type CircuitState = "closed" | "open" | "half_open";

type CircuitBreakerConfig = {
  /** Connector package ID */
  connectorId: string;
  /** Organization/workspace ID */
  organizationId: string;
  /** Number of failures before opening the circuit */
  failureThreshold?: number;
  /** Time in ms before attempting to transition from open to half_open */
  resetTimeoutMs?: number;
  /** Max concurrent probes allowed in half_open state */
  halfOpenMax?: number;
};

type CircuitData = {
  state: CircuitState;
  failureCount: number;
  lastFailure: number | null;
  halfOpenAttempts: number;
};

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 60_000;
const DEFAULT_HALF_OPEN_MAX = 1;
const CIRCUIT_TTL_SECONDS = 86_400; // 24h

/** Module-level instance cache keyed by `${connectorId}:${organizationId}` */
const instances = new Map<string, CircuitBreaker>();

/** Track whether the no-Redis warning has been logged */
let noRedisWarningLogged = false;

/**
 * Error thrown when a circuit breaker is open and rejecting requests.
 */
class CircuitOpenError extends IntegrationError {
  constructor(connectorId: string) {
    super(`Circuit breaker open for connector: ${connectorId}`, {
      connectorId,
    });
    this.name = "CircuitOpenError";
  }
}

/**
 * Distributed circuit breaker backed by Redis.
 *
 * States:
 * - `closed` — requests pass through normally
 * - `open` — requests are rejected immediately
 * - `half_open` — a limited number of probe requests are allowed
 */
class CircuitBreaker {
  private readonly connectorId: string;
  private readonly organizationId: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMax: number;
  private readonly redisKey: string;

  constructor(config: CircuitBreakerConfig) {
    this.connectorId = config.connectorId;
    this.organizationId = config.organizationId;
    this.failureThreshold =
      config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = config.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
    this.halfOpenMax = config.halfOpenMax ?? DEFAULT_HALF_OPEN_MAX;
    this.redisKey = `circuit:${this.connectorId}:${this.organizationId}`;
  }

  /**
   * Execute a function through the circuit breaker.
   * @param fn - Async function to protect
   * @returns Result of `fn`
   * @throws CircuitOpenError when the circuit is open and not ready for probing
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // No-op passthrough when Redis is unavailable
    if (!cacheClient) {
      if (!noRedisWarningLogged) {
        logger.warn("Circuit breaker disabled: no Redis connection");
        noRedisWarningLogged = true;
      }

      return fn();
    }

    const data = await this.getState();

    if (data.state === "open") {
      const elapsed = Date.now() - (data.lastFailure ?? 0);

      if (elapsed < this.resetTimeoutMs) {
        throw new CircuitOpenError(this.connectorId);
      }

      // Reset timeout elapsed, transition to half_open
      await this.setState({
        state: "half_open",
        failureCount: data.failureCount,
        lastFailure: data.lastFailure,
        halfOpenAttempts: 0,
      });

      logger.info("Circuit breaker transitioning to half_open", {
        connectorId: this.connectorId,
        organizationId: this.organizationId,
      });
    }

    // Re-read state after potential transition
    const current = data.state === "open" ? await this.getState() : data;

    if (
      current.state === "half_open" &&
      current.halfOpenAttempts >= this.halfOpenMax
    ) {
      throw new CircuitOpenError(this.connectorId);
    }

    // If half_open, increment probe count before executing
    if (current.state === "half_open") {
      await this.setState({
        ...current,
        halfOpenAttempts: current.halfOpenAttempts + 1,
      });
    }

    try {
      const result = await fn();
      await this.recordSuccess();

      return result;
    } catch (error) {
      await this.recordFailure();

      throw error;
    }
  }

  /**
   * Read circuit state from Redis.
   * Defaults to closed if no key exists.
   */
  async getState(): Promise<CircuitData> {
    if (!cacheClient) {
      return {
        state: "closed",
        failureCount: 0,
        lastFailure: null,
        halfOpenAttempts: 0,
      };
    }

    const raw = await cacheClient.get(this.redisKey);

    if (!raw) {
      return {
        state: "closed",
        failureCount: 0,
        lastFailure: null,
        halfOpenAttempts: 0,
      };
    }

    return JSON.parse(raw) as CircuitData;
  }

  /**
   * Write circuit state to Redis with a 24h TTL.
   */
  private async setState(data: CircuitData): Promise<void> {
    if (!cacheClient) return;

    await cacheClient.set(
      this.redisKey,
      JSON.stringify(data),
      "EX",
      CIRCUIT_TTL_SECONDS,
    );
  }

  /**
   * Record a failure and potentially open the circuit.
   */
  private async recordFailure(): Promise<void> {
    const data = await this.getState();
    const newCount = data.failureCount + 1;
    const now = Date.now();

    if (newCount >= this.failureThreshold) {
      await this.setState({
        state: "open",
        failureCount: newCount,
        lastFailure: now,
        halfOpenAttempts: 0,
      });

      logger.warn("Circuit breaker opened", {
        connectorId: this.connectorId,
        organizationId: this.organizationId,
        failureCount: newCount,
      });
    } else {
      await this.setState({
        ...data,
        failureCount: newCount,
        lastFailure: now,
      });
    }
  }

  /**
   * Record a success and reset to closed.
   */
  private async recordSuccess(): Promise<void> {
    const data = await this.getState();

    // Only write if there is state to reset
    if (data.failureCount === 0 && data.state === "closed") return;

    await this.setState({
      state: "closed",
      failureCount: 0,
      lastFailure: null,
      halfOpenAttempts: 0,
    });

    if (data.state !== "closed") {
      logger.info("Circuit breaker reset to closed", {
        connectorId: this.connectorId,
        organizationId: this.organizationId,
      });
    }
  }
}

/**
 * Execute a function with circuit breaker protection.
 * Reuses existing breaker instances per connector/organization pair.
 * @param connectorId - Connector package ID
 * @param organizationId - Organization/workspace ID
 * @param fn - Async function to protect
 * @param options - Optional circuit breaker configuration overrides
 */
async function withCircuitBreaker<T>(
  connectorId: string,
  organizationId: string,
  fn: () => Promise<T>,
  options?: Partial<CircuitBreakerConfig>,
): Promise<T> {
  const key = `${connectorId}:${organizationId}`;

  let breaker = instances.get(key);

  if (!breaker) {
    breaker = new CircuitBreaker({
      connectorId,
      organizationId,
      ...options,
    });
    instances.set(key, breaker);
  }

  return breaker.execute(fn);
}

export type { CircuitBreakerConfig, CircuitData, CircuitState };
export { CircuitBreaker, CircuitOpenError, withCircuitBreaker };
