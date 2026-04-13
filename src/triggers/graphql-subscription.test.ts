/**
 * GraphQL Subscription Trigger Runner Tests
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// Stub db
const mockInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() =>
      Promise.resolve([
        {
          id: "run-1",
          engineWorkflowId: "gql-wf-1-123",
        },
      ]),
    ),
  })),
}));

const mockUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));

const mockFindMany = mock(() => Promise.resolve([]));

mock.module("db", () => ({
  getDb: () => ({
    insert: mockInsert,
    update: mockUpdate,
    query: {
      workflowTable: {
        findMany: mockFindMany,
      },
    },
  }),
}));

// Stub hatchet
const mockEventPush = mock(() => Promise.resolve());
mock.module("@hatchet-dev/typescript-sdk", () => ({
  default: {
    init: () => ({
      event: { push: mockEventPush },
    }),
  },
}));

// Stub graphql-ws
const mockSubscribeDispose = mock(() => undefined);
const mockSubscribe = mock(() => mockSubscribeDispose);
mock.module("graphql-ws", () => ({
  createClient: mock(() => ({
    subscribe: mockSubscribe,
    dispose: mock(() => Promise.resolve()),
  })),
}));

// Stub db/schema (not used directly in tests but imported by the module)
mock.module("db/schema", () => ({
  workflowTable: {},
  workflowRunTable: {},
}));

// Stub drizzle-orm
mock.module("drizzle-orm", () => ({
  eq: mock((col: unknown, val: unknown) => ({ col, val })),
}));

// Stub lib/logger
mock.module("lib/logger", () => ({
  default: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

import { buildActiveSubscriptions } from "./graphql-subscription";

import type { Workflow } from "db/schema";

describe("buildActiveSubscriptions", () => {
  beforeEach(() => {
    mockSubscribe.mockClear();
    mockSubscribeDispose.mockClear();
  });

  it("returns an empty map when no workflows have graphql_subscription triggers", async () => {
    const workflows: Pick<Workflow, "id" | "organizationId" | "definition">[] =
      [
        {
          id: "wf-1",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: { type: "webhook", config: {} },
              },
            ],
          },
        },
      ];

    const result = await buildActiveSubscriptions(workflows);
    expect(result.size).toBe(0);
  });

  it("returns a map entry for a workflow with a graphql_subscription trigger", async () => {
    const workflows: Pick<Workflow, "id" | "organizationId" | "definition">[] =
      [
        {
          id: "wf-gql-1",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "graphql_subscription",
                  config: {
                    endpoint: "http://api.example.com/graphql",
                    query: "subscription { onMessage { id text } }",
                  },
                },
              },
            ],
          },
        },
      ];

    const result = await buildActiveSubscriptions(workflows);
    expect(result.size).toBe(1);
    expect(result.has("wf-gql-1")).toBe(true);
    // The value should be a dispose function
    expect(typeof result.get("wf-gql-1")).toBe("function");
  });

  it("normalizes http:// endpoint to ws://", async () => {
    const workflows: Pick<Workflow, "id" | "organizationId" | "definition">[] =
      [
        {
          id: "wf-gql-2",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "graphql_subscription",
                  config: {
                    endpoint: "http://api.example.com/graphql",
                    query: "subscription { onMessage { id } }",
                  },
                },
              },
            ],
          },
        },
      ];

    await buildActiveSubscriptions(workflows);
    // createClient should have been called with the ws:// URL
    const { createClient } = await import("graphql-ws");
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://api.example.com/graphql",
      }),
    );
  });

  it("normalizes https:// endpoint to wss://", async () => {
    const workflows: Pick<Workflow, "id" | "organizationId" | "definition">[] =
      [
        {
          id: "wf-gql-3",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "graphql_subscription",
                  config: {
                    endpoint: "https://api.example.com/graphql",
                    query: "subscription { onMessage { id } }",
                  },
                },
              },
            ],
          },
        },
      ];

    await buildActiveSubscriptions(workflows);
    const { createClient } = await import("graphql-ws");
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://api.example.com/graphql",
      }),
    );
  });

  it("skips workflows with missing required config fields", async () => {
    const workflows: Pick<Workflow, "id" | "organizationId" | "definition">[] =
      [
        {
          id: "wf-bad",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "graphql_subscription",
                  config: {
                    // missing query
                    endpoint: "ws://api.example.com/graphql",
                  },
                },
              },
            ],
          },
        },
      ];

    const result = await buildActiveSubscriptions(workflows);
    expect(result.size).toBe(0);
  });
});
