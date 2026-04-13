/**
 * Rivet Plugin Tests
 *
 * Tests for the built-in Rivet AI agent graph execution plugin.
 * Mocks `@ironclad/rivet-core` to avoid loading the full runtime.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// --- Mock rivet-core ---

const mockCoreRunGraph = mock();
const mockLoadProjectFromString = mock();

mock.module("@ironclad/rivet-core", () => ({
  coreRunGraph: mockCoreRunGraph,
  loadProjectFromString: mockLoadProjectFromString,
}));

// Must be imported AFTER mock.module
const { rivetPlugin } = await import("../plugins/builtin/rivet");

const validGraph = JSON.stringify({
  graphs: { main: { nodes: [] } },
  metadata: { id: "test-project" },
});

describe("rivetPlugin", () => {
  beforeEach(() => {
    mockCoreRunGraph.mockReset();
    mockLoadProjectFromString.mockReset();
  });

  describe("execute action", () => {
    it("should execute a graph and return output", async () => {
      const mockProject = { graphs: {}, metadata: {} };

      mockLoadProjectFromString.mockReturnValue(mockProject);
      mockCoreRunGraph.mockResolvedValue({
        response: { type: "string", value: "Hello from Rivet" },
        score: { type: "number", value: 0.95 },
      });

      const result = await rivetPlugin.actions.execute.handler({
        graph: validGraph,
        inputs: { prompt: "test prompt" },
      });

      expect(result.success).toBe(true);
      expect(result.output).toEqual({
        response: "Hello from Rivet",
        score: 0.95,
      });
      expect(mockLoadProjectFromString).toHaveBeenCalledWith(validGraph);
      expect(mockCoreRunGraph).toHaveBeenCalledWith(
        mockProject,
        expect.objectContaining({
          inputs: { prompt: "test prompt" },
        }),
      );
    });

    it("should return error for missing graph input", async () => {
      const result = await rivetPlugin.actions.execute.handler({
        inputs: { prompt: "test" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("graph");
    });

    it("should return error for invalid graph JSON", async () => {
      mockLoadProjectFromString.mockImplementation(() => {
        throw new SyntaxError("Unexpected token");
      });

      const result = await rivetPlugin.actions.execute.handler({
        graph: "not-valid-json{{{",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unexpected token");
    });

    it("should pass inputs and providerConfig correctly", async () => {
      const mockProject = { graphs: {}, metadata: {} };

      mockLoadProjectFromString.mockReturnValue(mockProject);
      mockCoreRunGraph.mockResolvedValue({});

      const providerConfig = {
        openAiKey: "sk-test-key",
        openAiEndpoint: "https://api.example.com",
      };

      const result = await rivetPlugin.actions.execute.handler({
        graph: validGraph,
        inputs: { query: "hello", temperature: 0.7 },
        providerConfig,
      });

      expect(result.success).toBe(true);
      expect(mockCoreRunGraph).toHaveBeenCalledWith(
        mockProject,
        expect.objectContaining({
          inputs: { query: "hello", temperature: 0.7 },
          openAiKey: "sk-test-key",
          openAiEndpoint: "https://api.example.com",
        }),
      );
    });

    it("should pass graphName option when provided", async () => {
      const mockProject = { graphs: {}, metadata: {} };

      mockLoadProjectFromString.mockReturnValue(mockProject);
      mockCoreRunGraph.mockResolvedValue({});

      await rivetPlugin.actions.execute.handler({
        graph: validGraph,
        graphName: "my-subgraph",
        inputs: {},
      });

      expect(mockCoreRunGraph).toHaveBeenCalledWith(
        mockProject,
        expect.objectContaining({
          graph: "my-subgraph",
        }),
      );
    });

    it("should handle runtime execution errors", async () => {
      const mockProject = { graphs: {}, metadata: {} };

      mockLoadProjectFromString.mockReturnValue(mockProject);
      mockCoreRunGraph.mockRejectedValue(
        new Error("Node execution failed: missing API key"),
      );

      const result = await rivetPlugin.actions.execute.handler({
        graph: validGraph,
        inputs: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("missing API key");
    });

    it("should default inputs to empty object when omitted", async () => {
      const mockProject = { graphs: {}, metadata: {} };

      mockLoadProjectFromString.mockReturnValue(mockProject);
      mockCoreRunGraph.mockResolvedValue({
        out: { type: "string", value: "done" },
      });

      const result = await rivetPlugin.actions.execute.handler({
        graph: validGraph,
      });

      expect(result.success).toBe(true);
      expect(mockCoreRunGraph).toHaveBeenCalledWith(
        mockProject,
        expect.objectContaining({
          inputs: {},
        }),
      );
    });
  });
});
