/**
 * Schedule Queue Flusher
 *
 * Periodically checks for workflows with schedule constraints that have
 * queued events. When the schedule window reopens, queued events are
 * flushed and dispatched.
 */

import { getDb } from "db";
import { workflowRunTable, workflowTable } from "db/schema";
import { eq } from "drizzle-orm";

import { getHatchet } from "lib/hatchet";
import logger from "lib/logger";
import {
  extractSchedule,
  flushScheduleQueue,
  isInWindow,
} from "./schedule-filter";

const FLUSH_INTERVAL_MS = 60 * 1_000;

let flushInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Scan workflows for schedule-constrained triggers with queued events,
 * and flush them if the window is now open.
 */
async function flushScheduleQueues(): Promise<void> {
  const db = getDb();

  try {
    const workflows = await db.query.workflowTable.findMany({
      where: eq(workflowTable.isActive, true),
      columns: {
        id: true,
        organizationId: true,
        definition: true,
      },
    });

    for (const workflow of workflows) {
      const schedule = extractSchedule(workflow.definition);
      if (!schedule || schedule.behavior !== "queue") continue;
      if (!isInWindow(schedule)) continue;

      const events = await flushScheduleQueue(workflow.id);
      if (events.length === 0) continue;

      logger.info("Flushing schedule queue", {
        workflowId: workflow.id,
        eventCount: events.length,
      });

      for (const eventPayload of events) {
        const engineWorkflowId = `scheduled-${workflow.id}-${Date.now()}`;
        const engineRunId = `run-${crypto.randomUUID()}`;

        let runId: string | undefined;

        try {
          let parsedData: unknown;
          try {
            parsedData = JSON.parse(eventPayload);
          } catch {
            parsedData = eventPayload;
          }

          const [run] = await db
            .insert(workflowRunTable)
            .values({
              workflowId: workflow.id,
              engineWorkflowId,
              engineRunId,
              status: "pending",
              input: {
                trigger: "schedule_flush",
                data: parsedData,
                receivedAt: new Date().toISOString(),
              },
            })
            .returning();

          runId = run.id;

          await getHatchet().event.push("workflow:execute", {
            workflowId: run.engineWorkflowId,
            runId: run.id,
            organizationId: workflow.organizationId,
            triggerData: {
              trigger: "schedule_flush",
              data: parsedData,
              receivedAt: new Date().toISOString(),
            },
            definition: workflow.definition,
          });

          await db
            .update(workflowRunTable)
            .set({ status: "running" })
            .where(eq(workflowRunTable.id, run.id));
        } catch (err) {
          logger.error("Failed to dispatch flushed schedule event", {
            workflowId: workflow.id,
            error: err instanceof Error ? err.message : String(err),
          });

          if (runId) {
            await db
              .update(workflowRunTable)
              .set({ status: "failed", completedAt: new Date() })
              .where(eq(workflowRunTable.id, runId))
              .catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    logger.error("Error during schedule queue flush", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the periodic schedule queue flusher.
 */
export function startScheduleQueueFlusher(): void {
  if (flushInterval) {
    logger.warn("Schedule queue flusher already running");
    return;
  }

  logger.info("Schedule queue flusher started");

  flushScheduleQueues();
  flushInterval = setInterval(flushScheduleQueues, FLUSH_INTERVAL_MS);
}

/**
 * Stop the schedule queue flusher.
 */
export function stopScheduleQueueFlusher(): void {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }

  logger.info("Schedule queue flusher stopped");
}
