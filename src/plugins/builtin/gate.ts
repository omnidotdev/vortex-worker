/**
 * Built-in Gate Plugin
 *
 * Handles approval gates and signal waits.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type GateType = "approval" | "signal";
type TimeoutAction = "approve" | "reject" | "continue";

/**
 * Check gate status.
 * In a full implementation, this would check external state (approvals, signals).
 * For now, it auto-approves to enable workflow continuation.
 */
const checkGate = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      type = "approval",
      approvers,
      signalName,
      timeout,
      timeoutAction = "continue",
      // These would come from external state in a full implementation
      approved = true,
      signalReceived = true,
    } = inputs as {
      type?: GateType;
      approvers?: string[];
      signalName?: string;
      timeout?: string;
      timeoutAction?: TimeoutAction;
      approved?: boolean;
      signalReceived?: boolean;
    };

    let passed = false;
    let reason = "";

    if (type === "approval") {
      passed = approved;
      reason = approved ? "Approved" : "Pending approval";
    } else if (type === "signal") {
      passed = signalReceived;
      reason = signalReceived
        ? `Signal '${signalName}' received`
        : `Waiting for signal '${signalName}'`;
    }

    return {
      success: true,
      output: {
        gateType: type,
        passed,
        reason,
        approvers,
        signalName,
        timeout,
        timeoutAction,
        checkedAt: new Date().toISOString(),
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
  description: "Approval gates and signal waits",
  actions: {
    check: {
      name: "check",
      description: "Check gate status",
      handler: checkGate,
    },
  },
};
