/**
 * Built-in Template Plugin
 *
 * Render string templates with variable substitution.
 * Uses {{variable}} syntax for placeholders.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Template render input */
interface TemplateRenderInput {
  /** Template content with {{variable}} placeholders */
  content: string;
  /** Variables to substitute into the template */
  variables: Record<string, unknown>;
}

/**
 * Render a template string with variable substitution.
 */
const renderTemplate = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { content, variables } = inputs as unknown as TemplateRenderInput;

    if (typeof content !== "string") {
      return {
        success: false,
        error: "Content must be a string",
        durationMs: performance.now() - startTime,
      };
    }

    if (!variables || typeof variables !== "object") {
      return {
        success: false,
        error: "Variables must be an object",
        durationMs: performance.now() - startTime,
      };
    }

    // Match {{variable}} patterns and replace with values.
    const result = content.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      if (key in variables) {
        const value = variables[key];

        if (value === null || value === undefined) {
          return "";
        }

        if (typeof value === "object") {
          return JSON.stringify(value);
        }

        return String(value);
      }

      // Return original placeholder if variable not found.
      return match;
    });

    // Find variables that were used.
    const usedVariables: string[] = [];
    const missingVariables: string[] = [];

    content.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      if (key in variables) {
        if (!usedVariables.includes(key)) {
          usedVariables.push(key);
        }
      } else {
        if (!missingVariables.includes(key)) {
          missingVariables.push(key);
        }
      }

      return "";
    });

    return {
      success: true,
      output: {
        result,
        usedVariables,
        missingVariables,
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
 * Template built-in plugin definition.
 */
export const templatePlugin: BuiltinPlugin = {
  id: "builtin:template",
  name: "Template",
  description: "Render string templates with variable substitution",
  actions: {
    render: {
      name: "render",
      description: "Render a template with variable substitution",
      handler: renderTemplate,
    },
  },
};
