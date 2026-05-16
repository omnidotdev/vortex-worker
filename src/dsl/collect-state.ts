/**
 * Manage pending collect step state in Valkey.
 *
 * Key patterns:
 * - `vortex:collect:{correlationValue}`: JSON array of pending collects
 * - `vortex:collect:_keys`: SET of active correlation key paths
 *
 * When a workflow reaches a collect step, it registers its expected
 * events here and pauses. When incoming events arrive, the router
 * calls `matchEvent` to check if any pending collects are satisfied.
 */

import { cacheClient } from "lib/cache/client";
import logger from "lib/logger";

import type { OmniEvent } from "../events/types";

export type PendingCollect = {
  workflowRunId: string;
  stepId: string;
  events: Array<{
    name: string;
    sourcePattern: string;
    typePattern: string;
  }>;
  mode: "all" | "any" | "n_of_m";
  minRequired?: number;
  correlationKey: string;
  correlationValue: string;
  receivedEvents: Record<
    string,
    {
      id: string;
      type: string;
      source: string;
      data: Record<string, unknown>;
      timestamp: string;
    }
  >;
  /** Absolute timestamp (ms) when this collect expires */
  timeout: number;
};

export type CompletedCollect = {
  workflowRunId: string;
  stepId: string;
  correlationValue: string;
  receivedEvents: PendingCollect["receivedEvents"];
};

export type TimedOutCollect = {
  workflowRunId: string;
  stepId: string;
  correlationValue: string;
};

/** Key for the SET of active correlation key paths */
const ACTIVE_KEYS_KEY = "vortex:collect:_keys";

/**
 * Build the cache key for a given correlation value
 */
function collectKey(correlationValue: string): string {
  return `vortex:collect:${correlationValue}`;
}

/**
 * Extract a nested value from an object by dot-separated path
 */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Register a pending collect (called when workflow reaches a collect step).
 *
 * Adds the correlation key path to the active keys index so
 * `matchEvent` can do direct lookups instead of scanning.
 */
export async function registerCollect(pending: PendingCollect): Promise<void> {
  if (!cacheClient) {
    logger.warn("Cache not available, collect step cannot register");
    return;
  }

  const key = collectKey(pending.correlationValue);

  // Atomically add to the pending list (avoids duplicate registrations)
  const script = `
    local key = KEYS[1]
    local raw = redis.call('GET', key)
    local list = {}
    if raw then
      list = cjson.decode(raw)
    end

    -- Remove existing entry for same workflow run + step
    local filtered = {}
    for _, item in ipairs(list) do
      if not (item.workflowRunId == ARGV[2] and item.stepId == ARGV[3]) then
        table.insert(filtered, item)
      end
    end

    -- Add the new pending collect
    local pending = cjson.decode(ARGV[1])
    table.insert(filtered, pending)

    -- Set with TTL
    local ttl = tonumber(ARGV[4])
    redis.call('SETEX', key, ttl, cjson.encode(filtered))

    return 1
  `;

  const ttlMs = pending.timeout - Date.now();
  const ttlSeconds = Math.max(Math.ceil(ttlMs / 1000), 60);

  await cacheClient.eval(
    script,
    1,
    key,
    JSON.stringify(pending),
    pending.workflowRunId,
    pending.stepId,
    String(ttlSeconds),
  );

  // Track the correlation key path for efficient lookups
  await cacheClient.sadd(ACTIVE_KEYS_KEY, pending.correlationKey);

  logger.info("Registered pending collect", {
    workflowRunId: pending.workflowRunId,
    stepId: pending.stepId,
    correlationValue: pending.correlationValue,
    correlationKey: pending.correlationKey,
    expectedEvents: pending.events.length,
    mode: pending.mode,
  });
}

/**
 * Lua script that atomically matches an event against pending collects.
 *
 * Prevents race conditions from concurrent event delivery by doing
 * the read-match-update cycle in a single atomic operation.
 *
 * Returns JSON: { completed: [...], timedOut: [...] }
 */
const MATCH_EVENT_SCRIPT = `
  local key = KEYS[1]
  local raw = redis.call('GET', key)
  if not raw then
    return cjson.encode({ completed = {}, timedOut = {} })
  end

  local list = cjson.decode(raw)
  local eventSource = ARGV[1]
  local eventType = ARGV[2]
  local eventId = ARGV[3]
  local eventData = ARGV[4]
  local eventTimestamp = ARGV[5]
  local nowMs = tonumber(ARGV[6])
  local correlationValue = ARGV[7]

  local completed = {}
  local timedOut = {}
  local remaining = {}
  local mutated = false

  for _, pending in ipairs(list) do
    -- Check correlation value
    if pending.correlationValue ~= correlationValue then
      table.insert(remaining, pending)
    -- Check timeout
    elseif nowMs > pending.timeout then
      mutated = true
      table.insert(timedOut, {
        workflowRunId = pending.workflowRunId,
        stepId = pending.stepId,
        correlationValue = pending.correlationValue,
      })
    else
      -- Try matching against expected event patterns
      local matched = false
      for _, expected in ipairs(pending.events) do
        if pending.receivedEvents[expected.name] == nil then
          -- Inline glob match (Lua pattern: convert * to .*)
          local function globMatch(pattern, value)
            if pattern == "*" then return true end
            local escaped = pattern:gsub("([%.%+%?%^%$%(%)%[%]%%])", "%%%1")
            local regex = "^" .. escaped:gsub("%*", ".*") .. "$"
            return value:match(regex) ~= nil
          end

          if globMatch(expected.sourcePattern, eventSource) and
             globMatch(expected.typePattern, eventType) then
            pending.receivedEvents[expected.name] = {
              id = eventId,
              type = eventType,
              source = eventSource,
              data = cjson.decode(eventData),
              timestamp = eventTimestamp,
            }
            matched = true
            mutated = true
            break
          end
        end
      end

      -- Check completion
      local receivedCount = 0
      for _ in pairs(pending.receivedEvents) do
        receivedCount = receivedCount + 1
      end

      local isComplete = false
      if pending.mode == "all" then
        isComplete = receivedCount >= #pending.events
      elseif pending.mode == "any" then
        isComplete = receivedCount >= 1
      elseif pending.mode == "n_of_m" then
        isComplete = receivedCount >= (pending.minRequired or 1)
      end

      if matched and isComplete then
        mutated = true
        table.insert(completed, {
          workflowRunId = pending.workflowRunId,
          stepId = pending.stepId,
          correlationValue = pending.correlationValue,
          receivedEvents = pending.receivedEvents,
        })
      else
        table.insert(remaining, pending)
      end
    end
  end

  if mutated then
    if #remaining == 0 then
      redis.call('DEL', key)
    else
      local maxTimeout = 0
      for _, c in ipairs(remaining) do
        if c.timeout > maxTimeout then maxTimeout = c.timeout end
      end
      local ttl = math.max(math.ceil((maxTimeout - nowMs) / 1000), 60)
      redis.call('SETEX', key, ttl, cjson.encode(remaining))
    end
  end

  return cjson.encode({ completed = completed, timedOut = timedOut })
`;

type MatchEventResult = {
  completed: CompletedCollect[];
  timedOut: TimedOutCollect[];
};

/**
 * Check if an incoming event matches any pending collects.
 *
 * Uses direct key lookup via the active correlation keys index
 * instead of scanning all keys. Each match is processed atomically
 * via a Lua script to prevent race conditions.
 */
export async function matchEvent(event: OmniEvent): Promise<MatchEventResult> {
  if (!cacheClient) return { completed: [], timedOut: [] };

  const allCompleted: CompletedCollect[] = [];
  const allTimedOut: TimedOutCollect[] = [];

  // Get all active correlation key paths (e.g., "organizationId", "userId")
  const activeKeyPaths = await cacheClient.smembers(ACTIVE_KEYS_KEY);

  if (activeKeyPaths.length === 0) return { completed: [], timedOut: [] };

  // For each key path, extract the value from the event and do a direct lookup
  const checked = new Set<string>();

  for (const keyPath of activeKeyPaths) {
    const value = getByPath(event.data, keyPath);
    if (value === undefined || value === null) continue;

    const correlationValue = String(value);
    const key = collectKey(correlationValue);

    // Avoid checking the same key twice (different paths, same value)
    if (checked.has(key)) continue;
    checked.add(key);

    try {
      const resultJson = (await cacheClient.eval(
        MATCH_EVENT_SCRIPT,
        1,
        key,
        event.source,
        event.type,
        event.id,
        JSON.stringify(event.data),
        event.timestamp,
        String(Date.now()),
        correlationValue,
      )) as string;

      const result = JSON.parse(resultJson) as MatchEventResult;

      for (const c of result.completed) {
        logger.info("Collect step completed", {
          workflowRunId: c.workflowRunId,
          stepId: c.stepId,
          correlationValue: c.correlationValue,
          receivedEvents: Object.keys(c.receivedEvents),
        });
        allCompleted.push(c);
      }

      for (const t of result.timedOut) {
        logger.info("Collect step timed out", {
          workflowRunId: t.workflowRunId,
          stepId: t.stepId,
          correlationValue: t.correlationValue,
        });
        allTimedOut.push(t);
      }
    } catch (err) {
      logger.warn("Failed to match event against collect key", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { completed: allCompleted, timedOut: allTimedOut };
}

/**
 * Remove a pending collect (on completion or timeout)
 * @knipignore
 */
export async function removeCollect(
  correlationValue: string,
  workflowRunId: string,
  stepId: string,
): Promise<void> {
  if (!cacheClient) return;

  const key = collectKey(correlationValue);

  const script = `
    local key = KEYS[1]
    local raw = redis.call('GET', key)
    if not raw then return 0 end

    local list = cjson.decode(raw)
    local filtered = {}
    for _, item in ipairs(list) do
      if not (item.workflowRunId == ARGV[1] and item.stepId == ARGV[2]) then
        table.insert(filtered, item)
      end
    end

    if #filtered == 0 then
      redis.call('DEL', key)
    else
      local maxTimeout = 0
      for _, c in ipairs(filtered) do
        if c.timeout > maxTimeout then maxTimeout = c.timeout end
      end
      local nowMs = tonumber(ARGV[3])
      local ttl = math.max(math.ceil((maxTimeout - nowMs) / 1000), 60)
      redis.call('SETEX', key, ttl, cjson.encode(filtered))
    end

    return 1
  `;

  await cacheClient.eval(
    script,
    1,
    key,
    workflowRunId,
    stepId,
    String(Date.now()),
  );
}
