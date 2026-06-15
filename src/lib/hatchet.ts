import { Hatchet } from "@hatchet-dev/typescript-sdk";

/**
 * Lazily-constructed shared Hatchet v1 client. Constructed on first use (NOT at
 * module load) because Hatchet.init() throws without HATCHET_CLIENT_TOKEN, which
 * would break unit tests that import modules transitively. Used by the worker
 * bootstrap (hatchet.worker) and the executor adapter (event.push / runs).
 * Workflow definitions do NOT use this; they use the client-less CreateTaskWorkflow
 * / CreateWorkflow factories so they need no token at import.
 */
let client: ReturnType<typeof Hatchet.init> | undefined;

export function getHatchet(): ReturnType<typeof Hatchet.init> {
  if (!client) client = Hatchet.init();
  return client;
}
