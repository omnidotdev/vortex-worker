/**
 * Built-in Prompt Plugin
 *
 * Execute prompt templates with variable substitution.
 * Placeholder implementation - in production, call LLM API via MCP server.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Prompt execution input parameters */
export interface PromptInput {
  /** MCP server ID to route request to */
  serverId: string;
  /** Model to use for generation */
  model: string;
  /** Prompt template with {{variable}} placeholders */
  template: string;
  /** Variables to substitute in template */
  variables?: Record<string, string>;
  /** Temperature for generation (0-2, default: 1) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
}

/** Prompt execution output */
export interface PromptOutput {
  /** Generated response text */
  response: string;
  /** Model used */
  model: string;
  /** Rendered prompt (after variable substitution) */
  renderedPrompt: string;
  /** Token usage statistics */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Render template with variable substitution.
 * @param template - Template string with {{variable}} placeholders.
 * @param variables - Key-value pairs for substitution.
 * @returns Rendered string.
 */
const renderTemplate = (
  template: string,
  variables: Record<string, string>,
): string => {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return variables[key] ?? `{{${key}}}`;
  });
};

/**
 * Execute a prompt template with variable substitution.
 */
const executePrompt = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { serverId, model, template, variables, temperature, maxTokens } =
      inputs as unknown as PromptInput;

    if (!serverId) {
      return {
        success: false,
        error: "Server ID is required",
        durationMs: performance.now() - startTime,
      };
    }

    if (!model) {
      return {
        success: false,
        error: "Model is required",
        durationMs: performance.now() - startTime,
      };
    }

    if (!template) {
      return {
        success: false,
        error: "Template is required",
        durationMs: performance.now() - startTime,
      };
    }

    const renderedPrompt = renderTemplate(template, variables || {});

    // biome-ignore lint/suspicious/noConsoleLog: Placeholder for LLM integration.
    console.log(
      `TODO: Call LLM via MCP server ${serverId} with model ${model}`,
    );
    // biome-ignore lint/suspicious/noConsoleLog: Placeholder for LLM integration.
    console.log(`Temperature: ${temperature ?? 1}, Max tokens: ${maxTokens}`);

    // Placeholder: In production, call LLM API via MCP server.
    const output: PromptOutput = {
      response: `[Placeholder response for prompt: "${renderedPrompt.slice(0, 50)}..."]`,
      model,
      renderedPrompt,
      usage: {
        promptTokens: Math.ceil(renderedPrompt.length / 4),
        completionTokens: 50,
        totalTokens: Math.ceil(renderedPrompt.length / 4) + 50,
      },
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

/**
 * Prompt built-in plugin definition.
 */
export const promptPlugin: BuiltinPlugin = {
  id: "builtin:prompt",
  name: "Prompt",
  description: "Execute prompt templates with variable substitution",
  actions: {
    execute: {
      name: "execute",
      description: "Execute a prompt template",
      handler: executePrompt,
    },
  },
};
