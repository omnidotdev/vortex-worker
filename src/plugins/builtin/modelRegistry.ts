/**
 * Built-in Model Registry Plugin
 *
 * Unified AI model interface. Synapse (the Omni AI gateway) is the default
 * provider; OpenAI, Anthropic, HuggingFace, Ollama, Replicate, Together, Groq,
 * Mistral and Cohere stay available as BYOK for a step that names one.
 */

import {
  DEFAULT_SYNAPSE_MODEL,
  SYNAPSE_PROVIDER,
  resolveCredential,
  resolveProvider,
  synapseApiBaseUrl,
} from "./aiProvider";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type ModelProvider =
  | "synapse"
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
  /** AI provider (default: synapse) */
  provider?: string;
  /** Connection ID (for stored credentials) */
  connectionId?: string;
  /** Direct API key (alternative to connectionId) */
  apiKey?: string;
  /** Model identifier (default for synapse: auto) */
  model?: string;
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
  // OpenAI-compatible gateway; no legacy completions endpoint, so text
  // completion falls back to chat
  synapse: {
    get baseUrl() {
      return synapseApiBaseUrl();
    },
    chatEndpoint: "/chat/completions",
    embedEndpoint: "/embeddings",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
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
      // Anthropic uses different format
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
      // HuggingFace uses inputs field
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

const isModelProvider = (provider: string): provider is ModelProvider =>
  Object.hasOwn(providerConfigs, provider);

type PreparedCall =
  | {
      ok: true;
      provider: ModelProvider;
      config: ProviderConfig;
      apiKey: string | undefined;
      baseUrl: string;
      model: string | undefined;
    }
  | { ok: false; error: string };

/**
 * Resolve a step's provider (Synapse by default), endpoint, key and model,
 * applying the key/host pairing rules in `aiProvider`
 */
async function prepareCall(
  input: BaseInput,
  context?: PluginContext,
): Promise<PreparedCall> {
  const provider = resolveProvider(input);
  if (!isModelProvider(provider)) {
    return { ok: false, error: `Unsupported provider: ${provider}` };
  }

  const config = providerConfigs[provider];
  const credential = await resolveCredential(
    {
      provider,
      canonicalBaseUrl: config.baseUrl,
      apiKey: input.apiKey,
      connectionId: input.connectionId,
      baseUrl: input.baseUrl,
      requiresKey: Boolean(config.authHeader),
    },
    context,
  );
  if (!credential.ok) return credential;

  return {
    ok: true,
    provider,
    config,
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl,
    model:
      input.model ||
      (provider === SYNAPSE_PROVIDER ? DEFAULT_SYNAPSE_MODEL : undefined),
  };
}

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
    const prepared = await prepareCall(input, context);

    if (!prepared.ok) {
      return {
        success: false,
        error: prepared.error,
        durationMs: performance.now() - startTime,
      };
    }

    const { provider, config, apiKey, baseUrl, model } = prepared;
    let endpoint = config.chatEndpoint;

    // For HuggingFace, append model to URL
    if (provider === "huggingface") {
      endpoint = `/${model}`;
    }

    const url = `${baseUrl}${endpoint}`;

    let body: unknown = {
      model,
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

    // Anthropic requires version header
    if (provider === "anthropic") {
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
        error: `${provider} API error: ${error}`,
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
        model,
        provider,
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
    const requested = resolveProvider(input);
    const config = isModelProvider(requested)
      ? providerConfigs[requested]
      : undefined;

    if (!config?.completeEndpoint) {
      // Fallback to chat with single user message
      return chat(
        {
          ...input,
          messages: [{ role: "user", content: input.prompt }],
        },
        context,
      );
    }

    const prepared = await prepareCall(input, context);

    if (!prepared.ok) {
      return {
        success: false,
        error: prepared.error,
        durationMs: performance.now() - startTime,
      };
    }

    const { provider, apiKey, baseUrl, model } = prepared;
    const url = `${baseUrl}${config.completeEndpoint}`;

    const body = {
      model,
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
        error: `${provider} API error: ${error}`,
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
        model,
        provider,
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
    const requested = resolveProvider(input);
    const embedEndpoint = isModelProvider(requested)
      ? providerConfigs[requested].embedEndpoint
      : undefined;

    if (embedEndpoint === undefined) {
      return {
        success: false,
        error: `${requested} does not support embeddings`,
        durationMs: performance.now() - startTime,
      };
    }

    const prepared = await prepareCall(input, context);

    if (!prepared.ok) {
      return {
        success: false,
        error: prepared.error,
        durationMs: performance.now() - startTime,
      };
    }

    const { provider, config, apiKey, baseUrl, model } = prepared;
    let endpoint = embedEndpoint;

    // For HuggingFace, use model in URL
    if (provider === "huggingface") {
      endpoint = `/${model}`;
    }

    const url = `${baseUrl}${endpoint}`;

    let body: unknown;
    if (provider === "cohere") {
      body = {
        model,
        texts: Array.isArray(input.input) ? input.input : [input.input],
      };
    } else if (provider === "huggingface") {
      body = { inputs: input.input };
    } else if (provider === "ollama") {
      body = {
        model,
        prompt: Array.isArray(input.input) ? input.input[0] : input.input,
      };
    } else {
      body = {
        model,
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
        error: `${provider} API error: ${error}`,
        durationMs: performance.now() - startTime,
      };
    }

    const result = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
      embeddings?: number[][] | number[];
      embedding?: number[];
    };

    // Normalize response format
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
        model,
        provider,
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
    const prepared = await prepareCall(input, context);

    if (!prepared.ok) {
      return {
        success: false,
        error: prepared.error,
        durationMs: performance.now() - startTime,
      };
    }

    const { provider, config, apiKey, baseUrl } = prepared;

    // Not all providers have a models endpoint
    let url: string;
    if (
      provider === "synapse" ||
      provider === "openai" ||
      provider === "together" ||
      provider === "groq"
    ) {
      url = `${baseUrl}/models`;
    } else if (provider === "ollama") {
      url = `${baseUrl.replace("/api", "")}/api/tags`;
    } else if (provider === "mistral") {
      url = `${baseUrl}/models`;
    } else {
      return {
        success: true,
        output: {
          models: [],
          note: `${provider} does not have a models listing endpoint`,
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
        error: `${provider} API error: ${error}`,
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
        provider,
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
    "Unified AI model interface (Synapse by default; OpenAI, Anthropic, HuggingFace, Ollama, etc. as BYOK)",
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
