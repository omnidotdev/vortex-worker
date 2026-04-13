/**
 * Built-in Model Registry Plugin
 *
 * Unified AI model interface - BYOK for multiple providers.
 * Supports OpenAI, Anthropic, HuggingFace, Ollama, Replicate, Together, Groq, Mistral, Cohere.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type ModelProvider =
  | "openai"
  | "anthropic"
  | "huggingface"
  | "ollama"
  | "replicate"
  | "together"
  | "groq"
  | "mistral"
  | "cohere";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface BaseInput {
  /** AI provider */
  provider: ModelProvider;
  /** Connection ID (for stored credentials) */
  connectionId?: string;
  /** Direct API key (alternative to connectionId) */
  apiKey?: string;
  /** Model identifier */
  model: string;
  /** Custom base URL (for self-hosted or proxies) */
  baseUrl?: string;
}

interface ChatInput extends BaseInput {
  /** Chat messages */
  messages: Message[];
  /** Temperature (0-2) */
  temperature?: number;
  /** Max tokens to generate */
  maxTokens?: number;
  /** Top-p sampling */
  topP?: number;
  /** Stop sequences */
  stop?: string[];
}

interface CompleteInput extends BaseInput {
  /** Prompt text */
  prompt: string;
  /** Temperature */
  temperature?: number;
  /** Max tokens */
  maxTokens?: number;
  /** Stop sequences */
  stop?: string[];
}

interface EmbedInput extends BaseInput {
  /** Text(s) to embed */
  input: string | string[];
}

// Provider configurations

interface ProviderConfig {
  baseUrl: string;
  chatEndpoint: string;
  completeEndpoint?: string;
  embedEndpoint?: string;
  authHeader: string;
  authPrefix: string;
  requestTransform?: (body: unknown) => unknown;
  responseTransform?: (response: unknown) => unknown;
}

const providerConfigs: Record<ModelProvider, ProviderConfig> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    chatEndpoint: "/chat/completions",
    completeEndpoint: "/completions",
    embedEndpoint: "/embeddings",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    chatEndpoint: "/messages",
    authHeader: "x-api-key",
    authPrefix: "",
    requestTransform: (body) => {
      const b = body as {
        messages?: Message[];
        max_tokens?: number;
        model?: string;
      };
      // Anthropic uses different format.
      const systemMessage = b.messages?.find((m) => m.role === "system");
      const otherMessages = b.messages?.filter((m) => m.role !== "system");
      return {
        model: b.model,
        max_tokens: b.max_tokens ?? 1024,
        system: systemMessage?.content,
        messages: otherMessages,
      };
    },
    responseTransform: (response) => {
      const r = response as { content?: Array<{ text?: string }> };
      return {
        choices: [{ message: { content: r.content?.[0]?.text ?? "" } }],
      };
    },
  },
  huggingface: {
    baseUrl: "https://api-inference.huggingface.co/models",
    chatEndpoint: "",
    embedEndpoint: "",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    requestTransform: (body) => {
      const b = body as { messages?: Message[]; prompt?: string };
      // HuggingFace uses inputs field.
      if (b.messages) {
        return {
          inputs: b.messages.map((m) => m.content).join("\n"),
          parameters: { max_new_tokens: 256 },
        };
      }
      return { inputs: b.prompt };
    },
    responseTransform: (response) => {
      const r = response as Array<{ generated_text?: string }>;
      return {
        choices: [{ message: { content: r[0]?.generated_text ?? "" } }],
      };
    },
  },
  ollama: {
    baseUrl: "http://localhost:11434/api",
    chatEndpoint: "/chat",
    completeEndpoint: "/generate",
    embedEndpoint: "/embeddings",
    authHeader: "",
    authPrefix: "",
    requestTransform: (body) => {
      const b = body as { messages?: Message[]; model?: string };
      return {
        model: b.model,
        messages: b.messages,
        stream: false,
      };
    },
    responseTransform: (response) => {
      const r = response as { message?: { content?: string } };
      return {
        choices: [{ message: { content: r.message?.content ?? "" } }],
      };
    },
  },
  replicate: {
    baseUrl: "https://api.replicate.com/v1",
    chatEndpoint: "/predictions",
    authHeader: "Authorization",
    authPrefix: "Token ",
    requestTransform: (body) => {
      const b = body as { model?: string; messages?: Message[] };
      return {
        version: b.model,
        input: {
          prompt: b.messages?.map((m) => `${m.role}: ${m.content}`).join("\n"),
        },
      };
    },
  },
  together: {
    baseUrl: "https://api.together.xyz/v1",
    chatEndpoint: "/chat/completions",
    completeEndpoint: "/completions",
    embedEndpoint: "/embeddings",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    chatEndpoint: "/chat/completions",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    chatEndpoint: "/chat/completions",
    embedEndpoint: "/embeddings",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  cohere: {
    baseUrl: "https://api.cohere.ai/v1",
    chatEndpoint: "/chat",
    embedEndpoint: "/embed",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    requestTransform: (body) => {
      const b = body as { messages?: Message[]; model?: string };
      const lastMessage = b.messages?.findLast((m) => m.role === "user");
      const history = b.messages
        ?.filter((m) => m.role !== "system")
        .slice(0, -1)
        .map((m) => ({
          role: m.role === "user" ? "USER" : "CHATBOT",
          message: m.content,
        }));
      return {
        model: b.model,
        message: lastMessage?.content,
        chat_history: history,
      };
    },
    responseTransform: (response) => {
      const r = response as { text?: string };
      return {
        choices: [{ message: { content: r.text ?? "" } }],
      };
    },
  },
};

/**
 * Chat completion with any provider.
 */
const chat = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ChatInput;
    const config = providerConfigs[input.provider];

    const apiKey =
      input.apiKey ??
      (context?.connections?.[input.connectionId ?? ""]?.apiKey as
        | string
        | undefined);

    if (!apiKey && config.authHeader) {
      return {
        success: false,
        error: "API key required - provide connectionId or apiKey",
        durationMs: performance.now() - startTime,
      };
    }

    const baseUrl = input.baseUrl ?? config.baseUrl;
    let endpoint = config.chatEndpoint;

    // For HuggingFace, append model to URL.
    if (input.provider === "huggingface") {
      endpoint = `/${input.model}`;
    }

    const url = `${baseUrl}${endpoint}`;

    let body: unknown = {
      model: input.model,
      messages: input.messages,
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      top_p: input.topP,
      stop: input.stop,
    };

    if (config.requestTransform) {
      body = config.requestTransform(body);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (config.authHeader && apiKey) {
      headers[config.authHeader] = `${config.authPrefix}${apiKey}`;
    }

    // Anthropic requires version header.
    if (input.provider === "anthropic") {
      headers["anthropic-version"] = "2023-06-01";
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `${input.provider} API error: ${error}`,
        durationMs: performance.now() - startTime,
      };
    }

    let result = await response.json();

    if (config.responseTransform) {
      result = config.responseTransform(result);
    }

    const r = result as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      success: true,
      output: {
        content: r.choices?.[0]?.message?.content ?? "",
        model: input.model,
        provider: input.provider,
        usage: r.usage,
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
 * Text completion (non-chat).
 */
const complete = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as CompleteInput;
    const config = providerConfigs[input.provider];

    if (!config.completeEndpoint) {
      // Fallback to chat with single user message.
      return chat(
        {
          ...input,
          messages: [{ role: "user", content: input.prompt }],
        },
        context,
      );
    }

    const apiKey =
      input.apiKey ??
      (context?.connections?.[input.connectionId ?? ""]?.apiKey as
        | string
        | undefined);

    if (!apiKey && config.authHeader) {
      return {
        success: false,
        error: "API key required - provide connectionId or apiKey",
        durationMs: performance.now() - startTime,
      };
    }

    const baseUrl = input.baseUrl ?? config.baseUrl;
    const url = `${baseUrl}${config.completeEndpoint}`;

    const body = {
      model: input.model,
      prompt: input.prompt,
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      stop: input.stop,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (config.authHeader && apiKey) {
      headers[config.authHeader] = `${config.authPrefix}${apiKey}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `${input.provider} API error: ${error}`,
        durationMs: performance.now() - startTime,
      };
    }

    const result = (await response.json()) as {
      choices?: Array<{ text?: string }>;
      response?: string;
    };

    return {
      success: true,
      output: {
        content: result.choices?.[0]?.text ?? result.response ?? "",
        model: input.model,
        provider: input.provider,
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
 * Generate embeddings.
 */
const embed = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as EmbedInput;
    const config = providerConfigs[input.provider];

    if (!config.embedEndpoint) {
      return {
        success: false,
        error: `${input.provider} does not support embeddings`,
        durationMs: performance.now() - startTime,
      };
    }

    const apiKey =
      input.apiKey ??
      (context?.connections?.[input.connectionId ?? ""]?.apiKey as
        | string
        | undefined);

    if (!apiKey && config.authHeader) {
      return {
        success: false,
        error: "API key required - provide connectionId or apiKey",
        durationMs: performance.now() - startTime,
      };
    }

    const baseUrl = input.baseUrl ?? config.baseUrl;
    let endpoint = config.embedEndpoint;

    // For HuggingFace, use model in URL.
    if (input.provider === "huggingface") {
      endpoint = `/${input.model}`;
    }

    const url = `${baseUrl}${endpoint}`;

    let body: unknown;
    if (input.provider === "cohere") {
      body = {
        model: input.model,
        texts: Array.isArray(input.input) ? input.input : [input.input],
      };
    } else if (input.provider === "huggingface") {
      body = { inputs: input.input };
    } else if (input.provider === "ollama") {
      body = {
        model: input.model,
        prompt: Array.isArray(input.input) ? input.input[0] : input.input,
      };
    } else {
      body = {
        model: input.model,
        input: input.input,
      };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (config.authHeader && apiKey) {
      headers[config.authHeader] = `${config.authPrefix}${apiKey}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `${input.provider} API error: ${error}`,
        durationMs: performance.now() - startTime,
      };
    }

    const result = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
      embeddings?: number[][] | number[];
      embedding?: number[];
    };

    // Normalize response format.
    let embeddings: number[][] | number[];
    if (result.data) {
      embeddings = result.data.map((d) => d.embedding ?? []);
    } else if (result.embeddings) {
      embeddings = result.embeddings as number[][];
    } else if (result.embedding) {
      embeddings = [result.embedding];
    } else {
      embeddings = [];
    }

    return {
      success: true,
      output: {
        embeddings,
        model: input.model,
        provider: input.provider,
        dimensions: Array.isArray(embeddings[0])
          ? embeddings[0].length
          : embeddings.length,
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
 * List available models for a provider (where supported).
 */
const listModels = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as BaseInput;
    const config = providerConfigs[input.provider];

    const apiKey =
      input.apiKey ??
      (context?.connections?.[input.connectionId ?? ""]?.apiKey as
        | string
        | undefined);

    if (!apiKey && config.authHeader) {
      return {
        success: false,
        error: "API key required - provide connectionId or apiKey",
        durationMs: performance.now() - startTime,
      };
    }

    const baseUrl = input.baseUrl ?? config.baseUrl;

    // Not all providers have a models endpoint.
    let url: string;
    if (
      input.provider === "openai" ||
      input.provider === "together" ||
      input.provider === "groq"
    ) {
      url = `${baseUrl}/models`;
    } else if (input.provider === "ollama") {
      url = `${baseUrl.replace("/api", "")}/api/tags`;
    } else if (input.provider === "mistral") {
      url = `${baseUrl}/models`;
    } else {
      return {
        success: true,
        output: {
          models: [],
          note: `${input.provider} does not have a models listing endpoint`,
        },
        durationMs: performance.now() - startTime,
      };
    }

    const headers: Record<string, string> = {};
    if (config.authHeader && apiKey) {
      headers[config.authHeader] = `${config.authPrefix}${apiKey}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `${input.provider} API error: ${error}`,
        durationMs: performance.now() - startTime,
      };
    }

    const result = (await response.json()) as {
      data?: Array<{ id?: string; name?: string }>;
      models?: Array<{ name?: string; model?: string }>;
    };

    const models =
      result.data?.map((m) => m.id ?? m.name) ??
      result.models?.map((m) => m.name ?? m.model) ??
      [];

    return {
      success: true,
      output: {
        models,
        count: models.length,
        provider: input.provider,
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
 * Model Registry built-in plugin definition.
 */
export const modelRegistryPlugin: BuiltinPlugin = {
  id: "builtin:modelRegistry",
  name: "Model Registry",
  description:
    "Unified AI model interface (OpenAI, Anthropic, HuggingFace, Ollama, etc.)",
  actions: {
    chat: {
      name: "chat",
      description: "Chat completion with any provider",
      handler: chat,
    },
    complete: {
      name: "complete",
      description: "Text completion",
      handler: complete,
    },
    embed: {
      name: "embed",
      description: "Generate embeddings",
      handler: embed,
    },
    listModels: {
      name: "listModels",
      description: "List available models",
      handler: listModels,
    },
  },
};
