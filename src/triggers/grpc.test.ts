/**
 * gRPC Stream Trigger Runner Tests
 */

import { describe, expect, it, mock } from "bun:test";

// Stub db
const mockInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() =>
      Promise.resolve([{ id: "run-1", engineWorkflowId: "grpc-wf-1-123" }]),
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

// Stub adapters - provide a minimal GrpcStreamAdapter stub
class MockGrpcStreamAdapter {
  name = "grpc";
  source = "grpc";

  onEvent(_handler: unknown) {}
  async start() {}
  async stop() {}
}

mock.module("adapters", () => ({
  GrpcStreamAdapter: MockGrpcStreamAdapter,
}));

// Stub @grpc/grpc-js
mock.module("@grpc/grpc-js", () => ({
  credentials: {
    createInsecure: mock(() => ({})),
    createSsl: mock(() => ({})),
  },
  Metadata: mock(() => ({
    set: mock(() => undefined),
  })),
  loadPackageDefinition: mock(() => ({})),
}));

// Stub @grpc/proto-loader
mock.module("@grpc/proto-loader", () => ({
  loadSync: mock(() => ({})),
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

import { buildActiveGrpcAdapters } from "./grpc";

import type { Workflow } from "db/schema";

describe("gRPC stream trigger runner", () => {
  describe("extractGrpcConfig (via buildActiveGrpcAdapters)", () => {
    it("returns adapter for workflow with valid grpc_stream trigger config", async () => {
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
                  type: "grpc_stream",
                  config: {
                    address: "localhost:50051",
                    protoPath: "/protos/service.proto",
                    service: "mypackage.MyService",
                    method: "Subscribe",
                  },
                },
              },
            ],
          },
        },
      ];

      const adapters = await buildActiveGrpcAdapters(workflows);
      expect(adapters.size).toBe(1);
      expect(adapters.has("wf-1")).toBe(true);
    });

    it("returns empty map for workflow with non-grpc trigger", async () => {
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
      const adapters = await buildActiveGrpcAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("returns empty map when address is missing", async () => {
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
                  type: "grpc_stream",
                  config: {
                    protoPath: "/protos/service.proto",
                    service: "mypackage.MyService",
                    method: "Subscribe",
                  },
                },
              },
            ],
          },
        },
      ];
      const adapters = await buildActiveGrpcAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("returns empty map when service or method is missing", async () => {
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
                  type: "grpc_stream",
                  config: {
                    address: "localhost:50051",
                    protoPath: "/protos/service.proto",
                  },
                },
              },
            ],
          },
        },
      ];
      const adapters = await buildActiveGrpcAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("handles workflows without steps", async () => {
      const workflows: Pick<
        Workflow,
        "id" | "organizationId" | "definition"
      >[] = [{ id: "wf-5", organizationId: "org-1", definition: {} }];
      const adapters = await buildActiveGrpcAdapters(workflows);
      expect(adapters.size).toBe(0);
    });
  });
});
