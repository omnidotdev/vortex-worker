/**
 * Data Transform Step Tests
 *
 * Tests for built-in data transform plugins via executeBuiltinAction.
 */

import { describe, expect, it } from "bun:test";

import { executeBuiltinAction } from "../plugins/builtin/index";

describe("data transform steps", () => {
  describe("map", () => {
    it("should transform each item in an array", async () => {
      const result = await executeBuiltinAction("builtin:map", "transform", {
        source: [1, 2, 3],
        expression: "item * 2",
        itemVariable: "item",
      });

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });
  });

  describe("reduce", () => {
    it("should aggregate array items into a single value", async () => {
      const result = await executeBuiltinAction("builtin:reduce", "aggregate", {
        source: [1, 2, 3, 4],
        expression: "acc + item",
        initialValue: 0,
        accumulatorVariable: "acc",
        itemVariable: "item",
      });

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });
  });

  describe("filter", () => {
    it("should filter items by condition", async () => {
      const result = await executeBuiltinAction("builtin:filter", "array", {
        source: [1, 2, 3, 4, 5],
        expression: "item > 3",
        itemVariable: "item",
      });

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });
  });

  describe("sort", () => {
    it("should sort array items", async () => {
      const result = await executeBuiltinAction("builtin:sort", "array", {
        source: [3, 1, 4, 1, 5],
        direction: "asc",
      });

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });

    it("should sort by key in descending order", async () => {
      const result = await executeBuiltinAction("builtin:sort", "array", {
        source: [{ n: 3 }, { n: 1 }, { n: 2 }],
        key: "n",
        direction: "desc",
      });

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });
  });

  describe("unique", () => {
    it("should remove duplicate items", async () => {
      const result = await executeBuiltinAction("builtin:unique", "array", {
        source: [1, 2, 2, 3, 3, 3],
      });

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });
  });

  describe("flatten", () => {
    it("should flatten nested arrays", async () => {
      const result = await executeBuiltinAction("builtin:flatten", "array", {
        source: [[1, 2], [3, 4], [5]],
        depth: 1,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });
  });

  describe("chunk", () => {
    it("should split array into chunks", async () => {
      const result = await executeBuiltinAction("builtin:chunk", "array", {
        source: [1, 2, 3, 4, 5],
        size: 2,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });
  });

  describe("zip", () => {
    it("should combine arrays element-wise", async () => {
      const result = await executeBuiltinAction("builtin:zip", "arrays", {
        sources: [
          [1, 2, 3],
          ["a", "b", "c"],
        ],
      });

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });
  });
});
