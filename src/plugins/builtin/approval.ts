/**
 * Built-in Approval Plugin
 *
 * Request approval from designated users before workflow continues.
 * Workflow suspends here waiting for approval response.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Action to take when approval times out */
type TimeoutAction = "approve" | "reject" | "escalate";

/** Approval request input parameters */
export interface ApprovalRequestInput {
  /** Title of the approval request */
  title: string;
  /** Detailed message explaining what needs approval */
  message: string;
  /** List of user IDs or emails who can approve */
  approvers: string[];
  /** Timeout in seconds (optional) */
  timeout?: number;
  /** Action to take on timeout (default: reject) */
  timeoutAction?: TimeoutAction;
}

/** Approval request output */
export interface ApprovalRequestOutput {
  /** Unique ID for this approval request */
  requestId: string;
  /** Current status of the request */
  status: "pending" | "approved" | "rejected" | "expired";
  /** When the request was created */
  createdAt: string;
  /** When the request will expire (if timeout set) */
  expiresAt?: string;
  /** Workflow context */
  workflowId?: string;
  runId?: string;
}

/**
 * Request approval from designated approvers.
 */
const requestApproval = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      title,
      message,
      approvers,
      timeout,
      timeoutAction = "reject",
    } = inputs as unknown as ApprovalRequestInput;

    if (!title) {
      return {
        success: false,
        error: "title is required",
        durationMs: performance.now() - startTime,
      };
    }

    if (!message) {
      return {
        success: false,
        error: "message is required",
        durationMs: performance.now() - startTime,
      };
    }

    if (!approvers || approvers.length === 0) {
      return {
        success: false,
        error: "at least one approver is required",
        durationMs: performance.now() - startTime,
      };
    }

    const requestId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = timeout
      ? new Date(Date.now() + timeout * 1000).toISOString()
      : undefined;

    // TODO: Implement actual approval request persistence and notification
    // biome-ignore lint/suspicious/noConsole: Intentional runtime logging for plugin placeholder
    console.log(
      `[Approval] Request "${requestId}" created for workflow ${context?.workflowId}/${context?.runId}`,
      { title, message, approvers, timeout, timeoutAction },
    );

    const output: ApprovalRequestOutput = {
      requestId,
      status: "pending",
      createdAt,
      expiresAt,
      workflowId: context?.workflowId,
      runId: context?.runId,
    };

    return {
      success: true,
      output: output as unknown as Record<string, unknown>,
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

export const approvalPlugin: BuiltinPlugin = {
  id: "builtin:approval",
  name: "Approval",
  description: "Request approval from designated users before continuing",
  actions: {
    request: {
      name: "request",
      description: "Request approval from designated approvers",
      handler: requestApproval,
    },
  },
};
