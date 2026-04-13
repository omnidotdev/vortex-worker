/**
 * NATS Trigger Runner Tests
 */

import { describe, expect, it, mock } from "bun:test";

// Stub db
const mockInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() =>
      Promise.resolve([{ id: "run-1", engineWorkflowId: "nats-wf-1-123" }]),
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

// Stub adapters - provide a minimal NatsAdapter stub
class MockNatsAdapter {
  name = "nats";
  source = "nats";

  onEvent(_handler: unknown) {}
  async start() {}
  async stop() {}
}

mock.module("adapters", () => ({
  NatsAdapter: MockNatsAdapter,
}));

// Stub nats
mock.module("nats", () => ({
  connect: mock(() =>
    Promise.resolve({
      subscribe: mock(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
        }),
      })),
      drain: mock(() => Promise.resolve()),
      close: mock(() => Promise.resolve()),
    }),
  ),
}));

// Stub db/schema
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

import { buildActiveNatsAdapters } from "./nats";

import type { Workflow } from "db/schema";

describe("NATS trigger runner", () => {
  describe("extractNatsConfig (via buildActiveNatsAdapters)", () => {
    it("returns adapter for workflow with valid nats trigger config", async () => {
      const workflows: Pick<
        Workflow,
        "id" | "organizationId" | "definition"
      >[] = [
        {
          id: "wf-1",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "nats",
                  config: {
                    servers: "nats://localhost:4222",
                    subject: "events.>",
                  },
                },
              },
            ],
          },
        },
      ];

      const adapters = await buildActiveNatsAdapters(workflows);
      expect(adapters.size).toBe(1);
      expect(adapters.has("wf-1")).toBe(true);
    });

    it("returns empty map for workflow with non-nats trigger", async () => {
      const workflows: Pick<
        Workflow,
        "id" | "organizationId" | "definition"
      >[] = [
        {
          id: "wf-2",
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
      const adapters = await buildActiveNatsAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("returns empty map when servers is missing", async () => {
      const workflows: Pick<
        Workflow,
        "id" | "organizationId" | "definition"
      >[] = [
        {
          id: "wf-3",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "nats",
                  config: { subject: "events.>" },
                },
              },
            ],
          },
        },
      ];
      const adapters = await buildActiveNatsAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("returns empty map when subject is missing", async () => {
      const workflows: Pick<
        Workflow,
        "id" | "organizationId" | "definition"
      >[] = [
        {
          id: "wf-4",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "nats",
                  config: { servers: "nats://localhost:4222" },
                },
              },
            ],
          },
        },
      ];
      const adapters = await buildActiveNatsAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("handles workflows without steps", async () => {
      const workflows: Pick<
        Workflow,
        "id" | "organizationId" | "definition"
      >[] = [{ id: "wf-5", organizationId: "org-1", definition: {} }];
      const adapters = await buildActiveNatsAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("handles multiple workflows, only returns nats ones", async () => {
      const workflows: Pick<
        Workflow,
        "id" | "organizationId" | "definition"
      >[] = [
        {
          id: "wf-nats",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "nats",
                  config: {
                    servers: "nats://localhost:4222",
                    subject: "events.>",
                  },
                },
              },
            ],
          },
        },
        {
          id: "wf-kafka",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "kafka",
                  config: {
                    brokers: ["localhost:9092"],
                    topic: "events",
                    groupId: "g1",
                  },
                },
              },
            ],
          },
        },
      ];
      const adapters = await buildActiveNatsAdapters(workflows);
      expect(adapters.size).toBe(1);
      expect(adapters.has("wf-nats")).toBe(true);
      expect(adapters.has("wf-kafka")).toBe(false);
    });
  });
});
