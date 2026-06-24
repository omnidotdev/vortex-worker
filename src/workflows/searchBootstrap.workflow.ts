/**
 * Search Bootstrap Workflow
 *
 * One-time initialization of Meilisearch:
 * 1. Creates a search-only API key for tenant token generation
 * 2. Configures all product indexes with proper settings
 *
 * Triggered manually via event or on first deploy.
 * Safe to re-run - operations are idempotent.
 *
 * @see https://www.meilisearch.com/docs/learn/security/tenant_token_reference
 */

import { CreateWorkflow } from "@hatchet-dev/typescript-sdk/v1";

import {
  MEILISEARCH_MASTER_KEY,
  MEILISEARCH_URL,
} from "../lib/config/env.config";

/** Index configuration matching @omnidotdev/search package */
interface IndexConfig {
  name: string;
  searchableAttributes: string[];
  filterableAttributes: string[];
  sortableAttributes?: string[];
}

/** All Omni product indexes */
const INDEXES: IndexConfig[] = [
  // Runa - Project management
  {
    name: "runa_projects",
    searchableAttributes: ["name", "description", "tags"],
    filterableAttributes: [
      "organization_id",
      "workspace_id",
      "status",
      "owner_id",
      "created_at",
      "updated_at",
    ],
    sortableAttributes: ["name", "created_at", "updated_at"],
  },
  {
    name: "runa_tasks",
    searchableAttributes: ["title", "description"],
    filterableAttributes: [
      "organization_id",
      "workspace_id",
      "project_id",
      "status",
      "assignee_id",
      "priority",
      "created_at",
      "updated_at",
      "due_date",
    ],
    sortableAttributes: [
      "title",
      "created_at",
      "updated_at",
      "due_date",
      "priority",
    ],
  },
  {
    name: "runa_comments",
    searchableAttributes: ["content"],
    filterableAttributes: [
      "organization_id",
      "workspace_id",
      "task_id",
      "author_id",
      "created_at",
    ],
    sortableAttributes: ["created_at"],
  },
  // Backfeed - User feedback
  {
    name: "backfeed_projects",
    searchableAttributes: ["name", "description"],
    filterableAttributes: [
      "organization_id",
      "workspace_id",
      "status",
      "created_at",
      "updated_at",
    ],
    sortableAttributes: ["name", "created_at", "updated_at"],
  },
  {
    name: "backfeed_submissions",
    searchableAttributes: ["title", "content", "tags"],
    filterableAttributes: [
      "organization_id",
      "workspace_id",
      "project_id",
      "status",
      "type",
      "author_id",
      "created_at",
      "updated_at",
      "votes",
    ],
    sortableAttributes: ["created_at", "updated_at", "votes"],
  },
  // Arbor - Git hosting
  {
    name: "arbor_repositories",
    searchableAttributes: ["name", "description", "readme"],
    filterableAttributes: [
      "organization_id",
      "owner_id",
      "visibility",
      "language",
      "is_fork",
      "is_archived",
      "created_at",
      "updated_at",
      "stars",
    ],
    sortableAttributes: ["name", "created_at", "updated_at", "stars", "forks"],
  },
  {
    name: "arbor_users",
    searchableAttributes: ["username", "display_name", "bio"],
    filterableAttributes: ["organization_id", "created_at"],
    sortableAttributes: ["username", "created_at"],
  },
  {
    name: "arbor_issues",
    searchableAttributes: ["title", "body"],
    filterableAttributes: [
      "organization_id",
      "repo_id",
      "status",
      "author_id",
      "assignee_id",
      "labels",
      "created_at",
      "updated_at",
    ],
    sortableAttributes: ["created_at", "updated_at"],
  },
];

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 30000;

/** Max wait time for async tasks (ms) */
const TASK_POLL_TIMEOUT_MS = 60000;

/** Poll interval for task status (ms) */
const TASK_POLL_INTERVAL_MS = 500;

/** Search-only key name for identification */
const SEARCH_KEY_NAME = "omni-search-tenant-key";

/**
 * Wait for a Meilisearch async task to complete.
 * Meilisearch returns 202 for operations like index creation,
 * with a taskUid that must be polled until complete.
 */
async function waitForTask(taskUid: number): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < TASK_POLL_TIMEOUT_MS) {
    const response = await fetch(`${MEILISEARCH_URL}/tasks/${taskUid}`, {
      headers: { Authorization: `Bearer ${MEILISEARCH_MASTER_KEY}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Failed to get task status: ${response.status}`);
    }

    const task = (await response.json()) as { status: string; error?: unknown };

    if (task.status === "succeeded") {
      return;
    }

    if (task.status === "failed") {
      throw new Error(`Task failed: ${JSON.stringify(task.error)}`);
    }

    // Task still processing, wait and retry
    await new Promise((resolve) => setTimeout(resolve, TASK_POLL_INTERVAL_MS));
  }

  throw new Error(`Task ${taskUid} timed out after ${TASK_POLL_TIMEOUT_MS}ms`);
}

export const searchBootstrapWorkflow = CreateWorkflow({
  name: "search-bootstrap",
  description: "Initialize Meilisearch with API keys and indexes",
  on: {
    event: "search:bootstrap",
  },
});

const _createSearchKey = searchBootstrapWorkflow.task({
  name: "create-search-key",
  executionTimeout: "60s",
  retries: 3,
  fn: async (_input, ctx) => {
    if (!MEILISEARCH_URL || !MEILISEARCH_MASTER_KEY) {
      ctx.log("Meilisearch not configured, skipping bootstrap");
      return {
        success: false,
        error: "MEILISEARCH_URL or MEILISEARCH_MASTER_KEY not configured",
      };
    }

    ctx.log("Checking for existing search-only API key...");

    // List existing keys
    const keysResponse = await fetch(`${MEILISEARCH_URL}/keys`, {
      headers: { Authorization: `Bearer ${MEILISEARCH_MASTER_KEY}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!keysResponse.ok) {
      throw new Error(`Failed to list keys: ${keysResponse.status}`);
    }

    const keysData = (await keysResponse.json()) as {
      results: Array<{
        uid: string;
        name: string | null;
        actions: string[];
      }>;
    };

    // Check if search-only key already exists
    const existingKey = keysData.results.find(
      (k) =>
        k.name === SEARCH_KEY_NAME ||
        (k.actions.length === 1 && k.actions[0] === "search"),
    );

    if (existingKey) {
      ctx.log(`Search-only key already exists: ${existingKey.uid}`);
      return {
        success: true,
        keyUid: existingKey.uid,
        created: false,
      };
    }

    ctx.log("Creating new search-only API key...");

    // Create search-only key
    const createResponse = await fetch(`${MEILISEARCH_URL}/keys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MEILISEARCH_MASTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: SEARCH_KEY_NAME,
        description:
          "Search-only key for tenant token generation in Omni products",
        actions: ["search"],
        indexes: ["*"],
        expiresAt: null, // Never expires
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text().catch(() => "Unknown");
      throw new Error(
        `Failed to create search key: ${createResponse.status} - ${errorText}`,
      );
    }

    const newKey = (await createResponse.json()) as { uid: string };
    ctx.log(`Created search-only key: ${newKey.uid}`);

    return {
      success: true,
      keyUid: newKey.uid,
      created: true,
    };
  },
});

searchBootstrapWorkflow.task({
  name: "configure-indexes",
  parents: [_createSearchKey],
  // 5 min - indexes are configured sequentially with task polling
  executionTimeout: "300s",
  retries: 2,
  fn: async (_input, ctx) => {
    if (!MEILISEARCH_URL || !MEILISEARCH_MASTER_KEY) {
      return { success: false, error: "Meilisearch not configured" };
    }

    const results: Array<{
      index: string;
      created: boolean;
      configured: boolean;
    }> = [];

    for (const indexConfig of INDEXES) {
      ctx.log(`Configuring index: ${indexConfig.name}`);

      // Create index (idempotent - returns 409 if already exists)
      const createResponse = await fetch(`${MEILISEARCH_URL}/indexes`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MEILISEARCH_MASTER_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          uid: indexConfig.name,
          primaryKey: "id",
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const alreadyExists = createResponse.status === 409;
      let created = false;

      if (createResponse.status === 202) {
        // Async task - wait for completion
        const createTask = (await createResponse.json()) as {
          taskUid: number;
        };
        ctx.log(
          `Index ${indexConfig.name} creation task: ${createTask.taskUid}`,
        );
        await waitForTask(createTask.taskUid);
        created = true;
      } else if (!alreadyExists && createResponse.status !== 201) {
        ctx.log(
          `Warning: Could not create index ${indexConfig.name}: ${createResponse.status}`,
        );
      }

      // Update settings (also async)
      const settingsResponse = await fetch(
        `${MEILISEARCH_URL}/indexes/${indexConfig.name}/settings`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${MEILISEARCH_MASTER_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            searchableAttributes: indexConfig.searchableAttributes,
            filterableAttributes: indexConfig.filterableAttributes,
            sortableAttributes: indexConfig.sortableAttributes ?? [],
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );

      let configured = false;
      if (settingsResponse.status === 202) {
        const settingsTask = (await settingsResponse.json()) as {
          taskUid: number;
        };
        ctx.log(
          `Index ${indexConfig.name} settings task: ${settingsTask.taskUid}`,
        );
        await waitForTask(settingsTask.taskUid);
        configured = true;
      } else if (!settingsResponse.ok) {
        ctx.log(
          `Warning: Could not configure index ${indexConfig.name}: ${settingsResponse.status}`,
        );
      }

      results.push({
        index: indexConfig.name,
        created: created && !alreadyExists,
        configured,
      });
    }

    const successCount = results.filter((r) => r.configured).length;
    ctx.log(
      `Configured ${successCount}/${INDEXES.length} indexes successfully`,
    );

    return {
      success: successCount === INDEXES.length,
      indexCount: INDEXES.length,
      configuredCount: successCount,
      results,
    };
  },
});
