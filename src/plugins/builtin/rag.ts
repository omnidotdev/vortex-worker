/**
 * Built-in RAG Plugin
 *
 * Retrieval-augmented generation using a 3-stage pipeline:
 * embed → MCP vector search → LLM generation
 */

import { getMCPClient } from "../../mcp";
import { modelRegistryPlugin } from "./modelRegistry";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type RagInput = {
  serverId: string;
  model?: string;
  query: string;
  collection: string;
  topK?: number;
  promptTemplate?: string;
  provider?: string;
  apiKey?: string;
  connectionId?: string;
  baseUrl?: string;
  embeddingModel?: string;
};

const DEFAULT_TEMPLATE =
  "Answer the following question based on the provided context.\n\nContext:\n{context}\n\nQuestion: {query}\n\nAnswer:";

const executeRag = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as RagInput;
    const { query, collection, topK = 5, promptTemplate } = input;

    if (!input.serverId) {
      return {
        success: false,
        error: "Server ID is required",
        durationMs: performance.now() - startTime,
      };
    }

    if (!query) {
      return {
        success: false,
        error: "Query is required",
        durationMs: performance.now() - startTime,
      };
    }

    if (!collection) {
      return {
        success: false,
        error: "Collection is required",
        durationMs: performance.now() - startTime,
      };
    }

    // Stage 1: Embed the query
    const embedResult = await modelRegistryPlugin.actions.embed.handler(
      {
        provider: input.provider ?? "openai",
        model: input.embeddingModel ?? "text-embedding-3-small",
        apiKey: input.apiKey,
        connectionId: input.connectionId,
        baseUrl: input.baseUrl,
        input: query,
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

    const embedOutput = embedResult.output as {
      embeddings: number[][] | number[];
    };

    // Normalize to get a single query vector
    const queryVector: number[] = Array.isArray(embedOutput.embeddings[0])
      ? ((embedOutput.embeddings as number[][])[0] ?? [])
      : (embedOutput.embeddings as unknown as number[]);

    // Stage 2: MCP vector search
    const mcpClient = getMCPClient();

    if (!mcpClient.isConnected(input.serverId)) {
      return {
        success: false,
        error: `MCP server not connected: ${input.serverId}`,
        durationMs: performance.now() - startTime,
      };
    }

    const searchResult = await mcpClient.callTool(input.serverId, "search", {
      indexName: collection,
      queryVector,
      topK,
    });

    if (!searchResult.success) {
      return {
        success: false,
        error: searchResult.error ?? "Vector search failed",
        durationMs: performance.now() - startTime,
      };
    }

    const searchText = searchResult.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");

    type SearchDoc = {
      id: string;
      score: number;
      metadata?: Record<string, unknown>;
    };

    let docs: SearchDoc[];
    try {
      const parsed = searchText ? JSON.parse(searchText) : { results: [] };
      docs = (parsed.results ?? []) as SearchDoc[];
    } catch {
      docs = [];
    }

    // Stage 3: LLM generation with context
    const contextStr = docs
      .map(
        (d, i) =>
          `[${i + 1}] ${d.metadata?.text ?? JSON.stringify(d.metadata ?? {})}`,
      )
      .join("\n\n");

    const prompt = (promptTemplate ?? DEFAULT_TEMPLATE)
      .replace("{context}", contextStr)
      .replace("{query}", query);

    const genResult = await modelRegistryPlugin.actions.chat.handler(
      {
        provider: input.provider ?? "openai",
        model: input.model ?? "gpt-4o-mini",
        apiKey: input.apiKey,
        connectionId: input.connectionId,
        baseUrl: input.baseUrl,
        messages: [{ role: "user", content: prompt }],
      },
      context,
    );

    if (!genResult.success) {
      return {
        success: false,
        error: genResult.error,
        durationMs: performance.now() - startTime,
      };
    }

    const answer =
      (genResult.output as { content: string } | undefined)?.content ?? "";

    return {
      success: true,
      output: {
        answer,
        sources: docs.map((d) => ({
          id: d.id,
          score: d.score,
          metadata: d.metadata,
        })),
        collection,
        topK,
        model: input.model ?? "gpt-4o-mini",
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

export const ragPlugin: BuiltinPlugin = {
  id: "builtin:rag",
  name: "RAG",
  description: "Retrieval-augmented generation",
  actions: {
    query: {
      name: "query",
      description: "Answer questions using RAG",
      handler: executeRag,
    },
  },
};
