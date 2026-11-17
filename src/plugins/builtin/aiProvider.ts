/**
 * AI provider resolution shared by the agent and model registry plugins.
 *
 * Synapse, the Omni AI gateway, is the default provider: a step that names no
 * provider runs through Synapse (`auto` model routing, metered and budgeted
 * per the org's Synapse key). Vendor providers stay available as BYOK for a
 * step that names one.
 *
 * Key/host pairing rules, enforced before any request is made:
 * - A Synapse key (`synapse_` prefix) is only ever sent to the Synapse gateway
 * - The Synapse provider only ever targets the Synapse gateway
 * - A key the org stored for a provider only goes to that provider's own
 *   endpoint; a custom `baseUrl` needs a key passed with the step
 * - A custom `baseUrl` must pass the SSRF guard
 */

import { SYNAPSE_BASE_URL } from "lib/config/env.config";
import { assertSafeResolvedUrl } from "lib/ssrf";

import type { PluginContext } from "../types";

export const SYNAPSE_PROVIDER = "synapse";

/** Synapse smart-routing model used when a Synapse step names no model */
export const DEFAULT_SYNAPSE_MODEL = "auto";

const SYNAPSE_KEY_PREFIX = "synapse_";

/** Synapse's OpenAI-compatible API root (`/v1/chat/completions`, ...) */
export const synapseApiBaseUrl = (): string =>
  `${SYNAPSE_BASE_URL.replace(/\/+$/, "")}/v1`;

export const isSynapseKey = (key: string): boolean =>
  key.startsWith(SYNAPSE_KEY_PREFIX);

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/** Whether a URL points at the configured Synapse gateway (exact origin) */
export const isSynapseUrl = (url: string): boolean => {
  const origin = originOf(url);
  return origin !== undefined && origin === originOf(SYNAPSE_BASE_URL);
};

/**
 * Pick the provider for a step. An explicit provider always wins. A step that
 * names none but carries its own vendor key or endpoint predates the Synapse
 * default and keeps the old OpenAI default; everything else uses Synapse
 */
export function resolveProvider(input: {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}): string {
  if (input.provider) return input.provider;
  if (input.apiKey && isSynapseKey(input.apiKey)) return SYNAPSE_PROVIDER;
  if (input.apiKey || input.baseUrl) return "openai";
  return SYNAPSE_PROVIDER;
}

export type ResolvedCredential =
  | { ok: true; apiKey: string | undefined; baseUrl: string }
  | { ok: false; error: string };

interface CredentialRequest {
  provider: string;
  /** The provider's own API root, `undefined` for an unknown provider */
  canonicalBaseUrl: string | undefined;
  /** Key passed with the step */
  apiKey?: string;
  connectionId?: string;
  /** Custom endpoint passed with the step */
  baseUrl?: string;
  /** False for keyless providers (local Ollama) */
  requiresKey: boolean;
}

const fail = (error: string): ResolvedCredential => ({ ok: false, error });

/**
 * Resolve the endpoint and key for a provider call, applying the key/host
 * pairing rules. Key precedence: the step's own key, then a named connection,
 * then the key the org stored for this provider
 */
export async function resolveCredential(
  request: CredentialRequest,
  context?: PluginContext,
): Promise<ResolvedCredential> {
  const { provider, canonicalBaseUrl, connectionId, requiresKey } = request;
  const isSynapse = provider === SYNAPSE_PROVIDER;

  if (isSynapse && request.baseUrl && !isSynapseUrl(request.baseUrl)) {
    return fail(
      "The synapse provider only calls the Synapse gateway; remove baseUrl or name another provider",
    );
  }

  const baseUrl = request.baseUrl ?? canonicalBaseUrl;
  if (!baseUrl) {
    return fail(`Unknown provider "${provider}": set baseUrl`);
  }

  const isCanonical =
    canonicalBaseUrl !== undefined &&
    originOf(baseUrl) === originOf(canonicalBaseUrl);

  const connectionKey = connectionId
    ? (context?.connections?.[connectionId]?.apiKey as string | undefined)
    : undefined;

  let apiKey = request.apiKey ?? connectionKey;

  // Stored keys only go to the provider's own endpoint
  if (!apiKey && isCanonical) {
    apiKey = await context?.resolveProviderKey?.(provider);
  }

  if (apiKey && isSynapseKey(apiKey) && !isSynapseUrl(baseUrl)) {
    return fail(
      "A Synapse key can only be sent to the Synapse gateway; use the synapse provider",
    );
  }

  if (!apiKey && requiresKey) {
    if (isSynapse) {
      return fail(
        "Synapse API key required: connect Synapse in your workspace integrations or pass apiKey",
      );
    }
    return fail(
      isCanonical
        ? `API key required for ${provider}: connect it in your workspace integrations or pass apiKey`
        : `API key required for ${provider}: a custom baseUrl needs apiKey passed with the step`,
    );
  }

  if (!isCanonical) {
    try {
      await assertSafeResolvedUrl(baseUrl);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  return { ok: true, apiKey, baseUrl };
}
