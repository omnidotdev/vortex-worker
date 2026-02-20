/**
 * Built-in Vector Search Plugin
 *
 * Query vector databases for similarity search via MCP tool delegation.
 */

import { getMCPClient } from "../../mcp";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Vector search input parameters */
export type VectorSearchInput = {
  /** MCP server ID for the vector database */
  serverId: string;
  /** Query vector (required) */
  queryVector: number[];
  /** Name of the index to search (required) */
  indexName: string;
  /** Number of results to return (default: 10) */
  topK?: number;
  /** Minimum similarity score threshold */
  minScore?: number;
  /** Metadata filter */
  filter?: Record<string, unknown>;
  /** Whether to include vectors in results (default: false) */
  includeVectors?: boolean;
  /** Whether to include metadata in results (default: true) */
  includeMetadata?: boolean;
};

/** Single search result */
export type VectorSearchResult = {
  /** Document ID */
  id: string;
  /** Similarity score */
  score: number;
  /** Document metadata (if requested) */
  metadata?: Record<string, unknown>;
  /** Document vector (if requested) */
  vector?: number[];
};

/** Vector search output */
export type VectorSearchOutput = {
  /** Search results sorted by score */
  results: VectorSearchResult[];
  /** Index that was searched */
  indexName: string;
  /** Requested number of results */
  topK: number;
  /** Actual number of matches returned */
  matchCount: number;
};

/**
 * Search for similar vectors in a vector database.
 */
const search = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      serverId,
      queryVector,
      indexName,
      topK = 10,
      minScore,
      filter,
      includeVectors = false,
      includeMetadata = true,
    } = inputs as unknown as VectorSearchInput;

    if (!queryVector || !Array.isArray(queryVector)) {
      return {
        success: false,
        error: "Query vector is required",
        durationMs: performance.now() - startTime,
      };
    }

    if (!indexName) {
      return {
        success: false,
        error: "Index name is required",
        durationMs: performance.now() - startTime,
      };
    }

    if (!serverId) {
      return {
        success: false,
        error: "Server ID is required",
        durationMs: performance.now() - startTime,
      };
    }

    const mcpClient = getMCPClient();

    if (!mcpClient.isConnected(serverId)) {
      return {
        success: false,
        error: `MCP server not connected: ${serverId}`,
        durationMs: performance.now() - startTime,
      };
    }

    const callResult = await mcpClient.callTool(serverId, "search", {
      indexName,
      queryVector,
      topK,
      minScore,
      filter,
      includeVectors,
      includeMetadata,
    });

    if (!callResult.success) {
      return {
        success: false,
        error: callResult.error ?? "Vector search failed",
        durationMs: performance.now() - startTime,
      };
    }

    const textContent = callResult.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");

    let mcpOutput: { results?: VectorSearchResult[] };
    try {
      mcpOutput = textContent ? JSON.parse(textContent) : { results: [] };
    } catch {
      mcpOutput = { results: [] };
    }

    const results: VectorSearchResult[] = (mcpOutput.results ?? []).filter(
      (r) => !minScore || r.score >= minScore,
    );

    const output: VectorSearchOutput = {
      results,
      indexName,
      topK,
      matchCount: results.length,
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
 * Vector Search built-in plugin definition.
 */
export const vectorSearchPlugin: BuiltinPlugin = {
  id: "builtin:vectorSearch",
  name: "Vector Search",
  description: "Query vector databases for similarity search",
  actions: {
    search: {
      name: "search",
      description: "Search for similar vectors",
      handler: search,
    },
  },
};
