/**
 * Built-in Embedding Plugin
 *
 * Generate vector embeddings for text content via modelRegistry delegation.
 */

import { modelRegistryPlugin } from "./modelRegistry";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Embedding generation input parameters */
export type EmbeddingInput = {
  /** Text input (single string or array of strings) */
  input: string | string[];
  /** Model to use (default: text-embedding-3-small) */
  model?: string;
  /** Embedding dimensions (default: 1536) */
  dimensions?: number;
  /** AI provider (default: openai) */
  provider?: string;
  /** Direct API key */
  apiKey?: string;
  /** Stored connection ID (alternative to apiKey) */
  connectionId?: string;
  /** Custom base URL (for self-hosted or proxies) */
  baseUrl?: string;
};

/** Single embedding result */
export type EmbeddingResult = {
  /** Original text (truncated preview) */
  text: string;
  /** Generated embedding vector */
  vector: number[];
};

/** Embedding generation output */
export type EmbeddingOutput = {
  /** Generated embeddings */
  embeddings: EmbeddingResult[];
  /** Model used */
  model: string;
  /** Vector dimensions */
  dimensions: number;
  /** Estimated token count */
  tokenCount: number;
};

/**
 * Generate embeddings for text content.
 */
const generateEmbedding = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as EmbeddingInput;

    if (!input.input) {
      return {
        success: false,
        error: "Input text is required",
        durationMs: performance.now() - startTime,
      };
    }

    const texts = Array.isArray(input.input) ? input.input : [input.input];

    const embedResult = await modelRegistryPlugin.actions.embed.handler(
      {
        provider: input.provider ?? "openai",
        model: input.model ?? "text-embedding-3-small",
        apiKey: input.apiKey,
        connectionId: input.connectionId,
        baseUrl: input.baseUrl,
        input: texts,
      },
      context,
    );

    if (!embedResult.success) {
      return {
        success: false,
        error: embedResult.error,
        durationMs: performance.now() - startTime,
      };
    }

    if (!embedResult.output) {
      return {
        success: false,
        error: "Embed handler returned no output",
        durationMs: performance.now() - startTime,
      };
    }

    const raw = embedResult.output as {
      embeddings: number[][] | number[];
      dimensions: number;
    };

    // Normalize to number[][] regardless of what modelRegistry returns
    const vectors: number[][] =
      raw.embeddings.length === 0
        ? []
        : Array.isArray(raw.embeddings[0])
          ? (raw.embeddings as number[][])
          : [raw.embeddings as unknown as number[]];

    const embeddings: EmbeddingResult[] = texts.map((text, i) => ({
      text: text.slice(0, 50),
      vector: vectors[i] ?? [],
    }));

    const output: EmbeddingOutput = {
      embeddings,
      model: input.model ?? "text-embedding-3-small",
      dimensions: raw.dimensions ?? vectors[0]?.length ?? 0,
      tokenCount: texts.reduce((acc, t) => acc + Math.ceil(t.length / 4), 0),
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
 * Embedding built-in plugin definition.
 */
export const embeddingPlugin: BuiltinPlugin = {
  id: "builtin:embedding",
  name: "Embedding",
  description: "Generate vector embeddings for text content",
  actions: {
    generate: {
      name: "generate",
      description: "Generate embeddings for text",
      handler: generateEmbedding,
    },
  },
};
