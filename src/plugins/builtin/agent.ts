/**
 * Built-in Agent Plugin
 *
 * Autonomous AI agent execution using LLM tool calling and MCP tool execution.
 */

import { getMCPClient } from "../../mcp";
import { stateStore } from "../../state/store";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type AgentInput = {
  serverId: string;
  model?: string;
  goal: string;
  tools?: string[];
  maxIterations?: number;
  provider?: string;
  apiKey?: string;
  connectionId?: string;
  baseUrl?: string;
  systemPrompt?: string;
  conversationId?: string;
  memoryTtl?: number;
  streamEvents?: boolean;
};

type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

const MEMORY_KEY = (orgId: string, convId: string) =>
  `agent:memory:${orgId}:${convId}`;
const MAX_MEMORY_MESSAGES = 20;

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  mistral: "https://api.mistral.ai/v1",
};

function getApiBaseUrl(provider: string, baseUrl?: string): string {
  return baseUrl ?? PROVIDER_BASE_URLS[provider] ?? "https://api.openai.com/v1";
}

async function callLLMWithTools(
  provider: string,
  apiKey: string,
  model: string,
  messages: OpenAIMessage[],
  tools: OpenAITool[],
  baseUrl?: string,
): Promise<unknown> {
  const base = getApiBaseUrl(provider, baseUrl);
  const url = `${base}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  // Anthropic uses different auth headers
  if (provider === "anthropic") {
    headers["x-api-key"] = apiKey;
    delete headers.Authorization;
    headers["anthropic-version"] = "2023-06-01";
  }

  const body = {
    model,
    messages,
    ...(tools.length > 0 && { tools }),
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`${provider} API error: ${error}`);
  }

  return response.json();
}

const executeAgent = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as AgentInput;
    const {
      serverId,
      model = "gpt-4o-mini",
      goal,
      tools: toolFilter = [],
      maxIterations = 10,
      provider = "openai",
      apiKey: inputApiKey,
      connectionId,
      baseUrl,
      systemPrompt,
      conversationId,
      memoryTtl,
      streamEvents,
    } = input;

    if (!serverId) {
      return {
        success: false,
        error: "Server ID is required",
        durationMs: performance.now() - startTime,
      };
    }

    if (!goal) {
      return {
        success: false,
        error: "Goal is required",
        durationMs: performance.now() - startTime,
      };
    }

    // Resolve API key from input or connection context
    const apiKey =
      inputApiKey ??
      (context?.connections?.[connectionId ?? ""]?.apiKey as
        | string
        | undefined);

    if (!apiKey) {
      return {
        success: false,
        error: "API key required - provide connectionId or apiKey",
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

    const allMcpTools = await mcpClient.listTools(serverId);
    const selectedTools = toolFilter.length
      ? allMcpTools.filter((t) => toolFilter.includes(t.name))
      : allMcpTools;

    // Convert MCP tools to OpenAI function calling format
    const openaiTools: OpenAITool[] = selectedTools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));

    // Load conversation history from Redis if conversationId is set
    let conversationHistory: OpenAIMessage[] = [];
    if (conversationId && context?.organizationId) {
      const stored = await stateStore.getList(
        context.organizationId,
        MEMORY_KEY(context.organizationId, conversationId),
      );
      // Take the last MAX_MEMORY_MESSAGES messages to avoid context overflow
      conversationHistory = stored.slice(-MAX_MEMORY_MESSAGES) as OpenAIMessage[];
    }

    const messages: OpenAIMessage[] = [
      ...(systemPrompt
        ? [{ role: "system" as const, content: systemPrompt }]
        : []),
      ...conversationHistory,
      { role: "user" as const, content: goal },
    ];

    const steps: Array<{ tool: string; args: unknown; result: unknown }> = [];
    let iterations = 0;
    let finalResult = "";

    // Agentic loop: call LLM, execute tool calls, feed results back
    for (let i = 0; i < maxIterations; i++) {
      iterations = i + 1;

      const response = await callLLMWithTools(
        provider,
        apiKey,
        model,
        messages,
        openaiTools,
        baseUrl,
      );

      const r = response as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: OpenAIToolCall[];
          };
          finish_reason?: string;
        }>;
      };

      const message = r.choices?.[0]?.message;

      if (!message?.tool_calls?.length) {
        // No tool calls — agent has reached a final answer
        finalResult = message?.content ?? "";
        break;
      }

      // Add assistant message with tool calls to conversation history
      const assistantMessage: OpenAIMessage = {
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.tool_calls,
      };
      messages.push(assistantMessage);

      const iterationSteps: Array<{ tool: string; args: unknown; result: unknown }> = [];
      const toolResultMessages: OpenAIMessage[] = [];

      // Execute each tool call and feed results back
      for (const toolCall of message.tool_calls) {
        const toolName = toolCall.function.name;
        let toolArgs: Record<string, unknown>;

        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          toolArgs = {};
        }

        const toolResult = await mcpClient.callTool(
          serverId,
          toolName,
          toolArgs,
        );

        const toolResultText = toolResult.success
          ? (toolResult.content
              ?.filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join("\n") ?? "")
          : (toolResult.error ?? "Tool call failed");

        const stepEntry = {
          tool: toolName,
          args: toolArgs,
          result: toolResultText,
        };
        steps.push(stepEntry);
        iterationSteps.push(stepEntry);

        const toolResultMessage: OpenAIMessage = {
          role: "tool",
          content: toolResultText,
          tool_call_id: toolCall.id,
        };
        messages.push(toolResultMessage);
        toolResultMessages.push(toolResultMessage);
      }

      // Persist assistant message + tool results to Redis memory
      if (conversationId && context?.organizationId) {
        const messagesToAppend: OpenAIMessage[] = [assistantMessage, ...toolResultMessages];
        for (const msg of messagesToAppend) {
          await stateStore.append(
            context.organizationId,
            MEMORY_KEY(context.organizationId, conversationId),
            msg,
          );
        }
      }

      // Emit iteration event for SSE streaming
      if (streamEvents) {
        await context?.emit?.("agent:iteration", {
          iteration: i + 1,
          steps: iterationSteps,
        });
      }
    }

    if (!finalResult && iterations >= maxIterations) {
      finalResult = "Max iterations reached without a final answer";
    }

    // Persist the final assistant message and apply TTL if configured
    if (conversationId && context?.organizationId && finalResult) {
      await stateStore.append(
        context.organizationId,
        MEMORY_KEY(context.organizationId, conversationId),
        { role: "assistant" as const, content: finalResult },
      );
      if (memoryTtl) {
        await stateStore.set(
          context.organizationId,
          `agent:memory:${conversationId}:ttl_marker`,
          Date.now(),
          memoryTtl,
        );
      }
    }

    return {
      success: true,
      output: {
        result: finalResult,
        iterations,
        steps,
        model,
        provider,
        serverId,
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

export const agentPlugin: BuiltinPlugin = {
  id: "builtin:agent",
  name: "Agent",
  description: "Autonomous AI agent execution",
  actions: {
    execute: {
      name: "execute",
      description: "Execute an autonomous agent with a goal",
      handler: executeAgent,
    },
  },
};
