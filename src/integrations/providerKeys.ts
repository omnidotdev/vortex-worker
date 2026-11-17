/**
 * Org-stored AI provider keys for the agent and model registry plugins.
 *
 * A workflow's org stores provider keys as integrations (encrypted config,
 * one integration per type per org). The resolver is bound to the executing
 * org by the worker, never by step input, and only looks up AI provider
 * integration types so a step cannot pull an unrelated integration's secret
 * (a GitHub or Slack token) into an LLM request
 */

import { getIntegrationCredentials } from "./credentials";

import type { DecryptedCredentialValue } from "../connectors/types";

/** Integration types whose stored key an AI step may use */
export const AI_PROVIDER_INTEGRATION_TYPES: ReadonlySet<string> = new Set([
  "synapse",
  "openai",
  "anthropic",
  "huggingface",
  "replicate",
  "together",
  "groq",
  "mistral",
  "cohere",
]);

type CredentialLookup = (
  organizationId: string,
  integrationType: string,
) => Promise<DecryptedCredentialValue | undefined>;

/**
 * Build a key resolver bound to one org. Returns the stored API key for an AI
 * provider integration, or `undefined` when the provider is not an AI type or
 * the org has no usable key for it
 */
export function createProviderKeyResolver(
  organizationId: string,
  lookup: CredentialLookup = getIntegrationCredentials,
): (provider: string) => Promise<string | undefined> {
  return async (provider) => {
    if (!AI_PROVIDER_INTEGRATION_TYPES.has(provider)) return undefined;

    const credential = await lookup(organizationId, provider);

    return credential?.type === "secret_text" ? credential.secret : undefined;
  };
}
