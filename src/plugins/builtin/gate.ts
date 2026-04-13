/**
 * Built-in Gate Plugin
 *
 * Handles approval gates, signal waits, and manual continue steps.
 * Persists requests in the `approval_request` table so external
 * actors (UI, API, webhooks) can approve, reject, or send signals.
 */

import { getDb } from "db";
import { approvalRequestTable } from "db/schema";
import { eq } from "drizzle-orm";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type GateType = "approval" | "signal" | "manual";
type TimeoutAction = "approve" | "reject" | "continue";
type ApprovalStatus = "pending" | "approved" | "rejected";

/**
 * Create an approval request in the database.
 * Called when the workflow first reaches a gate step.
 */
const execute = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      gateType = "approval",
      title,
      approvers,
      signalName,
      timeout,
      timeoutAction = "reject",
    } = inputs as {
      gateType?: GateType;
      title?: string;
      approvers?: string[];
      signalName?: string;
      timeout?: string;
      timeoutAction?: TimeoutAction;
    };

    if (!context) {
      return {
        success: false,
        error: "Plugin context is required for gate execution",
        durationMs: performance.now() - startTime,
      };
    }

    const db = getDb();

    const [row] = await db
      .insert(approvalRequestTable)
      .values({
        organizationId: context.organizationId ?? "",
        workflowId: context.workflowId,
        runId: context.runId,
        stepId: context.stepId,
        gateType,
        title: title ?? null,
        approvers: approvers ?? null,
        signalName: signalName ?? null,
        timeoutMs: timeout ?? null,
        timeoutAction,
      })
      .returning({ id: approvalRequestTable.id });

    return {
      success: true,
      output: {
        requestId: row.id,
        status: "pending" as ApprovalStatus,
        gateType,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Check the current status of an approval request.
 * Handles timeout-based auto-decisions when the elapsed time exceeds `timeoutMs`.
 */
const check = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { requestId } = inputs as { requestId?: string };

    if (!requestId) {
      return {
        success: false,
        error: "requestId is required",
        durationMs: performance.now() - startTime,
      };
    }

    const db = getDb();

    const request = await db.query.approvalRequestTable.findFirst({
      where: eq(approvalRequestTable.id, requestId),
    });

    if (!request) {
      return {
        success: false,
        error: `Approval request not found: ${requestId}`,
        durationMs: performance.now() - startTime,
      };
    }

    // Handle timeout auto-decision for pending requests
    if (request.status === "pending" && request.timeoutMs) {
      const elapsed = Date.now() - new Date(request.createdAt).getTime();
      const timeoutMs = Number(request.timeoutMs);

      if (elapsed >= timeoutMs) {
        const action = (request.timeoutAction ?? "reject") as TimeoutAction;
        let decidedStatus: ApprovalStatus = "rejected";

        if (action === "approve") {
          decidedStatus = "approved";
        } else if (action === "continue") {
          decidedStatus = "approved";
        }

        const now = new Date();

        await db
          .update(approvalRequestTable)
          .set({
            status: decidedStatus,
            decidedBy: "system:timeout",
            reason: `Auto-${action} after ${timeoutMs}ms timeout`,
            decidedAt: now,
          })
          .where(eq(approvalRequestTable.id, requestId));

        return {
          success: true,
          output: {
            status: decidedStatus,
            passed: decidedStatus === "approved",
            decidedBy: "system:timeout",
            reason: `Auto-${action} after ${timeoutMs}ms timeout`,
            signalData: request.signalData ?? null,
          },
          durationMs: performance.now() - startTime,
        };
      }
    }

    return {
      success: true,
      output: {
        status: request.status,
        passed: request.status === "approved",
        decidedBy: request.decidedBy ?? null,
        reason: request.reason ?? null,
        signalData: request.signalData ?? null,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

export const gatePlugin: BuiltinPlugin = {
  id: "builtin:gate",
  name: "Gate",
  description: "Approval gates, signal waits, and manual continue steps",
  actions: {
    execute: {
      name: "execute",
      description: "Create an approval request for a gate step",
      handler: execute,
    },
    check: {
      name: "check",
      description: "Check the status of an approval request",
      handler: check,
    },
  },
};
