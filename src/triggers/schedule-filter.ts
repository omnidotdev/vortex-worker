/**
 * Schedule-based trigger filtering.
 *
 * Allows workflows to define time windows during which triggers are active.
 * Events outside the window are either silently dropped or queued in Valkey
 * for delivery when the window reopens.
 */

import { cacheClient } from "lib/cache";
import logger from "lib/logger";

export type ScheduleWindow = {
  /** Days of week (0=Sun..6=Sat) */
  days: number[];
  /** Start time in "HH:mm" format */
  startTime: string;
  /** End time in "HH:mm" format */
  endTime: string;
};

export type TriggerSchedule = {
  /** IANA timezone, e.g. "America/New_York" */
  timezone: string;
  /** One or more active windows */
  windows: ScheduleWindow[];
  /** What to do with out-of-window events */
  behavior: "drop" | "queue";
};

/**
 * Check if the given time falls within any schedule window.
 * Returns true if no schedule is defined (always-on).
 */
export function isInWindow(schedule?: TriggerSchedule, now?: Date): boolean {
  if (!schedule) return true;

  const currentTime = now ?? new Date();

  // Use Intl.DateTimeFormat for timezone-aware day/time extraction
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(currentTime);

  const weekdayStr = parts.find((p) => p.type === "weekday")?.value;
  const hourStr = parts.find((p) => p.type === "hour")?.value;
  const minuteStr = parts.find((p) => p.type === "minute")?.value;

  if (!weekdayStr || !hourStr || !minuteStr) return true;

  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayOfWeek = dayMap[weekdayStr] ?? -1;

  // Normalize hour (some locales return "24" for midnight)
  const hour = Number(hourStr) % 24;
  const minute = Number(minuteStr);
  const currentMinutes = hour * 60 + minute;

  for (const window of schedule.windows) {
    if (!window.days.includes(dayOfWeek)) continue;

    const [startH, startM] = window.startTime.split(":").map(Number);
    const [endH, endM] = window.endTime.split(":").map(Number);

    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
      return true;
    }
  }

  return false;
}

const QUEUE_KEY_PREFIX = "vortex:schedule:queue:";

/**
 * Buffer an event in Valkey sorted set for later delivery.
 */
export async function queueForWindow(
  workflowId: string,
  eventPayload: string,
): Promise<void> {
  if (!cacheClient) {
    logger.warn("Cannot queue schedule event, cache not available", {
      workflowId,
    });
    return;
  }

  const key = `${QUEUE_KEY_PREFIX}${workflowId}`;
  await cacheClient.zadd(key, Date.now(), eventPayload);
}

/**
 * Get and clear all queued events for a workflow.
 * Returns serialized event payloads ordered by queue time.
 */
export async function flushScheduleQueue(
  workflowId: string,
): Promise<string[]> {
  if (!cacheClient) return [];

  const key = `${QUEUE_KEY_PREFIX}${workflowId}`;

  // Atomically get all members and delete the key
  const members = await cacheClient.zrangebyscore(key, "-inf", "+inf");
  if (members.length > 0) {
    await cacheClient.del(key);
  }

  return members;
}

/**
 * Apply schedule filter to an incoming trigger event.
 * @returns true if the event should be dispatched immediately, false if handled
 */
export async function applyScheduleFilter(
  schedule: TriggerSchedule | undefined,
  workflowId: string,
  eventPayload: string,
): Promise<boolean> {
  if (isInWindow(schedule)) return true;

  if (schedule?.behavior === "queue") {
    await queueForWindow(workflowId, eventPayload);
    logger.info("Event queued for schedule window", { workflowId });
    return false;
  }

  // Drop behavior
  logger.debug("Event dropped outside schedule window", { workflowId });
  return false;
}

/**
 * Extract schedule config from a workflow definition.
 * Shared helper used by all trigger runners.
 */
export function extractSchedule(
  definition: unknown,
): TriggerSchedule | undefined {
  const def = definition as {
    steps?: Array<{
      type: string;
      trigger?: { schedule?: unknown };
    }>;
  };

  const triggerStep = def?.steps?.find((s) => s.type === "trigger");
  return triggerStep?.trigger?.schedule as TriggerSchedule | undefined;
}
