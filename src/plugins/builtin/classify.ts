/**
 * Built-in Classify Plugin
 *
 * Classify text content into categories.
 * Placeholder implementation - in production, call LLM API via MCP server.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Classification result for a single category */
export interface ClassificationResult {
  /** Category label */
  category: string;
  /** Confidence score (0-1) */
  confidence: number;
}

/** Classify input parameters */
export interface ClassifyInput {
  /** MCP server ID to route request to */
  serverId: string;
  /** Model to use for classification */
  model: string;
  /** Text to classify */
  input: string;
  /** Available categories */
  categories: string[];
  /** Whether to allow multiple labels */
  multiLabel?: boolean;
}

/** Classify output */
export interface ClassifyOutput {
  /** Classification results */
  classifications: ClassificationResult[];
  /** Model used */
  model: string;
  /** Whether multi-label was enabled */
  multiLabel: boolean;
  /** Top predicted category */
  topCategory: string;
  /** Confidence of top category */
  topConfidence: number;
}

/**
 * Generate placeholder classification results.
 * @param categories - Available categories.
 * @param multiLabel - Whether to return multiple labels.
 * @returns Placeholder classification results.
 */
const generatePlaceholderClassifications = (
  categories: string[],
  multiLabel: boolean,
): ClassificationResult[] => {
  if (categories.length === 0) {
    return [];
  }

  if (multiLabel) {
    // Return top 2-3 categories with decreasing confidence.
    const count = Math.min(3, categories.length);
    return categories.slice(0, count).map((category, index) => ({
      category,
      confidence: 0.9 - index * 0.2,
    }));
  }

  // Single label: return just the first category with high confidence.
  return [
    {
      category: categories[0],
      confidence: 0.95,
    },
  ];
};

/**
 * Classify text into categories.
 */
const classifyText = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { serverId, model, input, categories, multiLabel } =
      inputs as unknown as ClassifyInput;

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

    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      return {
        success: false,
        error: "Categories array is required and must not be empty",
        durationMs: performance.now() - startTime,
      };
    }

    const isMultiLabel = multiLabel ?? false;

    // biome-ignore lint/suspicious/noConsoleLog: Placeholder for LLM integration.
    console.log(
      `TODO: Call LLM via MCP server ${serverId} with model ${model}`,
    );
    // biome-ignore lint/suspicious/noConsoleLog: Placeholder for LLM integration.
    console.log(
      `Categories: ${categories.length}, Multi-label: ${isMultiLabel}`,
    );

    // Placeholder: In production, call LLM API via MCP server.
    const classifications = generatePlaceholderClassifications(
      categories,
      isMultiLabel,
    );

    const output: ClassifyOutput = {
      classifications,
      model,
      multiLabel: isMultiLabel,
      topCategory: classifications[0]?.category ?? "",
      topConfidence: classifications[0]?.confidence ?? 0,
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
 * Classify built-in plugin definition.
 */
export const classifyPlugin: BuiltinPlugin = {
  id: "builtin:classify",
  name: "Classify",
  description: "Classify text content into categories",
  actions: {
    text: {
      name: "text",
      description: "Classify text into categories",
      handler: classifyText,
    },
  },
};
