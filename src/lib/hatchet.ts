import { HatchetClient } from "@hatchet-dev/typescript-sdk/v1";

/**
 * Lazily-constructed shared Hatchet v1 client. Constructed on first use (NOT at
 * module load) because init() throws without HATCHET_CLIENT_TOKEN, which would
 * break unit tests that import modules transitively. Used by the worker
 * bootstrap (hatchet.worker) and the executor adapter (event.push / runs).
 * Imported from the /v1 subpath so the deprecated v0 root module is never loaded
 * (avoids the v0 deprecation banner on boot). Workflow definitions do NOT use
 * this; they use the client-less CreateTaskWorkflow / CreateWorkflow factories so
 * they need no token at import.
 */
let client: ReturnType<typeof HatchetClient.init> | undefined;

export function getHatchet(): ReturnType<typeof HatchetClient.init> {
  if (!client) client = HatchetClient.init();
  return client;
}
