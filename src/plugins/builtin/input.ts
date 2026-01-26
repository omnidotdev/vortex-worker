/**
 * Built-in Input Plugin
 *
 * Request user input via form fields before workflow continues.
 * Workflow suspends here waiting for input response.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Supported input field types */
type FieldType =
  | "text"
  | "number"
  | "email"
  | "textarea"
  | "select"
  | "checkbox";

/** Input field definition */
export interface InputField {
  /** Field identifier */
  name: string;
  /** Human-readable label */
  label: string;
  /** Field type */
  type: FieldType;
  /** Whether the field is required */
  required?: boolean;
  /** Options for select fields */
  options?: Array<{ label: string; value: string }>;
  /** Default value */
  default?: string | number | boolean;
}

/** Input request parameters */
export interface InputRequestInput {
  /** Title of the input request */
  title: string;
  /** Detailed message explaining what input is needed */
  message: string;
  /** Form fields to collect */
  fields: InputField[];
  /** List of user IDs or emails who can provide input */
  assignees?: string[];
  /** Timeout in seconds (optional) */
  timeout?: number;
}

/** Input request output */
export interface InputRequestOutput {
  /** Unique ID for this input request */
  requestId: string;
  /** Current status of the request */
  status: "pending" | "completed" | "expired";
  /** Field definitions */
  fields: InputField[];
  /** When the request was created */
  createdAt: string;
  /** When the request will expire (if timeout set) */
  expiresAt?: string;
  /** Workflow context */
  workflowId?: string;
  runId?: string;
}

/**
 * Request input from designated users.
 */
const requestInput = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { title, message, fields, assignees, timeout } =
      inputs as unknown as InputRequestInput;

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

    if (!fields || fields.length === 0) {
      return {
        success: false,
        error: "at least one field is required",
        durationMs: performance.now() - startTime,
      };
    }

    // Validate field definitions
    for (const field of fields) {
      if (!field.name || !field.label || !field.type) {
        return {
          success: false,
          error: `field must have name, label, and type: ${JSON.stringify(field)}`,
          durationMs: performance.now() - startTime,
        };
      }

      if (field.type === "select" && (!field.options || field.options.length === 0)) {
        return {
          success: false,
          error: `select field "${field.name}" must have options`,
          durationMs: performance.now() - startTime,
        };
      }
    }

    const requestId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = timeout
      ? new Date(Date.now() + timeout * 1000).toISOString()
      : undefined;

    // TODO: Implement actual input request persistence and notification
    // biome-ignore lint/suspicious/noConsole: Intentional runtime logging for plugin placeholder
    console.log(
      `[Input] Request "${requestId}" created for workflow ${context?.workflowId}/${context?.runId}`,
      { title, message, fields, assignees, timeout },
    );

    const output: InputRequestOutput = {
      requestId,
      status: "pending",
      fields,
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

export const inputPlugin: BuiltinPlugin = {
  id: "builtin:input",
  name: "Input",
  description: "Request user input via form fields before continuing",
  actions: {
    request: {
      name: "request",
      description: "Request input from designated users",
      handler: requestInput,
    },
  },
};
