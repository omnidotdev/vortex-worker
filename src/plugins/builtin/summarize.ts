/**
 * Built-in Summarize Plugin
 *
 * Summarize text content in different styles.
 * Placeholder implementation - in production, call LLM API via MCP server.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Summarization style */
export type SummarizeStyle = "brief" | "detailed" | "bullets";

/** Summarize input parameters */
export interface SummarizeInput {
  /** MCP server ID to route request to */
  serverId: string;
  /** Model to use for summarization */
  model: string;
  /** Text to summarize */
  input: string;
  /** Maximum length of summary (in characters) */
  maxLength?: number;
  /** Summary style */
  style?: SummarizeStyle;
}

/** Summarize output */
export interface SummarizeOutput {
  /** Generated summary */
  summary: string;
  /** Model used */
  model: string;
  /** Original text length */
  originalLength: number;
  /** Summary length */
  summaryLength: number;
  /** Style used */
  style: SummarizeStyle;
}

/**
 * Generate a placeholder summary based on style.
 * @param input - Original text.
 * @param style - Summary style.
 * @param maxLength - Maximum summary length.
 * @returns Placeholder summary.
 */
const generatePlaceholderSummary = (
  input: string,
  style: SummarizeStyle,
  maxLength?: number,
): string => {
  const preview = input.slice(0, 50);

  let summary: string;
  switch (style) {
    case "brief":
      summary = `[Brief summary of: "${preview}..."]`;
      break;
    case "detailed":
      summary = `[Detailed summary of: "${preview}..."]\n\nThis is a comprehensive analysis that covers the main points, key details, and supporting information from the original text.`;
      break;
    case "bullets":
      summary = `[Bullet summary of: "${preview}..."]\n\n- Key point 1\n- Key point 2\n- Key point 3`;
      break;
    default:
      summary = `[Summary of: "${preview}..."]`;
  }

  if (maxLength && summary.length > maxLength) {
    return `${summary.slice(0, maxLength - 3)}...`;
  }

  return summary;
};

/**
 * Summarize text content.
 */
const summarizeText = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { serverId, model, input, maxLength, style } =
      inputs as unknown as SummarizeInput;

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

    if (!input) {
      return {
        success: false,
        error: "Input text is required",
        durationMs: performance.now() - startTime,
      };
    }

    const summarizeStyle: SummarizeStyle = style || "brief";

    // biome-ignore lint/suspicious/noConsoleLog: Placeholder for LLM integration.
    console.log(
      `TODO: Call LLM via MCP server ${serverId} with model ${model}`,
    );
    // biome-ignore lint/suspicious/noConsoleLog: Placeholder for LLM integration.
    console.log(
      `Style: ${summarizeStyle}, Max length: ${maxLength ?? "unlimited"}`,
    );

    // Placeholder: In production, call LLM API via MCP server.
    const summary = generatePlaceholderSummary(input, summarizeStyle, maxLength);

    const output: SummarizeOutput = {
      summary,
      model,
      originalLength: input.length,
      summaryLength: summary.length,
      style: summarizeStyle,
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
 * Summarize built-in plugin definition.
 */
export const summarizePlugin: BuiltinPlugin = {
  id: "builtin:summarize",
  name: "Summarize",
  description: "Summarize text content in different styles",
  actions: {
    text: {
      name: "text",
      description: "Summarize text content",
      handler: summarizeText,
    },
  },
};
