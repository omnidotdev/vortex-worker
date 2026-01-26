/**
 * Built-in Chat Plugin
 *
 * Send chat messages to LLM models.
 * Placeholder implementation - in production, call LLM API via MCP server.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Chat message role */
export type ChatRole = "system" | "user" | "assistant";

/** Chat message */
export interface ChatMessage {
  /** Message role */
  role: ChatRole;
  /** Message content */
  content: string;
}

/** Chat input parameters */
export interface ChatInput {
  /** MCP server ID to route request to */
  serverId: string;
  /** Model to use for generation */
  model: string;
  /** Conversation messages */
  messages: ChatMessage[];
  /** Temperature for generation (0-2, default: 1) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
}

/** Chat output */
export interface ChatOutput {
  /** Generated response message */
  message: ChatMessage;
  /** Model used */
  model: string;
  /** Finish reason (stop, length, etc.) */
  finishReason: string;
  /** Token usage statistics */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Send chat messages to an LLM.
 */
const sendChat = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { serverId, model, messages, temperature, maxTokens } =
      inputs as unknown as ChatInput;

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

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return {
        success: false,
        error: "Messages array is required and must not be empty",
        durationMs: performance.now() - startTime,
      };
    }

    // biome-ignore lint/suspicious/noConsoleLog: Placeholder for LLM integration.
    console.log(
      `TODO: Call LLM via MCP server ${serverId} with model ${model}`,
    );
    // biome-ignore lint/suspicious/noConsoleLog: Placeholder for LLM integration.
    console.log(
      `Messages: ${messages.length}, Temperature: ${temperature ?? 1}, Max tokens: ${maxTokens}`,
    );

    // Calculate prompt tokens from all messages.
    const promptTokens = messages.reduce(
      (acc, msg) => acc + Math.ceil(msg.content.length / 4),
      0,
    );

    // Placeholder: In production, call LLM API via MCP server.
    const lastUserMessage = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    const output: ChatOutput = {
      message: {
        role: "assistant",
        content: `[Placeholder response to: "${lastUserMessage?.content.slice(0, 50) ?? "empty"}..."]`,
      },
      model,
      finishReason: "stop",
      usage: {
        promptTokens,
        completionTokens: 50,
        totalTokens: promptTokens + 50,
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
 * Chat built-in plugin definition.
 */
export const chatPlugin: BuiltinPlugin = {
  id: "builtin:chat",
  name: "Chat",
  description: "Send chat messages to LLM models",
  actions: {
    send: {
      name: "send",
      description: "Send chat messages and receive a response",
      handler: sendChat,
    },
  },
};
