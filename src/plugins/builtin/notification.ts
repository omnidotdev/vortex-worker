/**
 * Built-in Notification Plugin
 *
 * Send notifications via various channels (fire and forget).
 * Does not wait for response - workflow continues immediately.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Supported notification channels */
type NotificationChannel = "email" | "slack" | "webhook" | "push";

/** Notification priority levels */
type NotificationPriority = "low" | "normal" | "high" | "urgent";

/** Notification send input parameters */
export interface NotificationSendInput {
  /** Delivery channel */
  channel: NotificationChannel;
  /** List of recipients (email addresses, Slack IDs, webhook URLs, etc.) */
  recipients: string[];
  /** Notification title */
  title: string;
  /** Notification message body */
  message: string;
  /** Priority level (default: normal) */
  priority?: NotificationPriority;
  /** Additional channel-specific data */
  data?: Record<string, unknown>;
}

/** Notification send output */
export interface NotificationSendOutput {
  /** Unique ID for this notification */
  notificationId: string;
  /** Delivery channel used */
  channel: NotificationChannel;
  /** Number of recipients */
  recipientCount: number;
  /** When the notification was sent */
  sentAt: string;
  /** Workflow context */
  workflowId?: string;
  runId?: string;
}

/**
 * Send a notification via the specified channel.
 */
const sendNotification = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      channel,
      recipients,
      title,
      message,
      priority = "normal",
      data,
    } = inputs as unknown as NotificationSendInput;

    if (!channel) {
      return {
        success: false,
        error: "channel is required",
        durationMs: performance.now() - startTime,
      };
    }

    const validChannels: NotificationChannel[] = [
      "email",
      "slack",
      "webhook",
      "push",
    ];
    if (!validChannels.includes(channel)) {
      return {
        success: false,
        error: `invalid channel: ${channel}. Must be one of: ${validChannels.join(", ")}`,
        durationMs: performance.now() - startTime,
      };
    }

    if (!recipients || recipients.length === 0) {
      return {
        success: false,
        error: "at least one recipient is required",
        durationMs: performance.now() - startTime,
      };
    }

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

    const notificationId = crypto.randomUUID();
    const sentAt = new Date().toISOString();

    // TODO: Implement actual notification delivery per channel
    // biome-ignore lint/suspicious/noConsole: Intentional runtime logging for plugin placeholder
    console.log(
      `[Notification] Sending "${notificationId}" via ${channel} for workflow ${context?.workflowId}/${context?.runId}`,
      { title, message, recipients, priority, data },
    );

    const output: NotificationSendOutput = {
      notificationId,
      channel,
      recipientCount: recipients.length,
      sentAt,
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

export const notificationPlugin: BuiltinPlugin = {
  id: "builtin:notification",
  name: "Notification",
  description: "Send notifications via various channels",
  actions: {
    send: {
      name: "send",
      description: "Send a notification (fire and forget)",
      handler: sendNotification,
    },
  },
};
