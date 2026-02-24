import { describe, expect, it } from "bun:test";

import {
  applyTransform,
  evaluateCondition,
  isDuplicate,
  normalizeToCloudEvent,
} from "../router";

import type Redis from "ioredis";

describe("evaluateCondition", () => {
  it("returns true when condition is null (no filter)", () => {
    expect(evaluateCondition(null, { status: "ok" })).toBe(true);
  });

  it("returns true when JSONPath matches", () => {
    expect(evaluateCondition("$.status", { status: "error" })).toBe(true);
  });

  it("returns false when JSONPath returns empty (no match)", () => {
    expect(evaluateCondition("$.nonexistent", { status: "ok" })).toBe(false);
  });

  it("returns true for nested path match", () => {
    expect(evaluateCondition("$.user.id", { user: { id: 42 } })).toBe(true);
  });

  it("returns false for nested path miss", () => {
    expect(evaluateCondition("$.user.email", { user: { id: 42 } })).toBe(false);
  });

  it("returns false on invalid JSONPath expression (safe fallback)", () => {
    expect(evaluateCondition("!!!invalid", {})).toBe(false);
  });

  it("returns true when JSONPath matches a falsy value (false)", () => {
    expect(evaluateCondition("$.active", { active: false })).toBe(true);
  });

  it("returns true when JSONPath matches a zero value", () => {
    expect(evaluateCondition("$.count", { count: 0 })).toBe(true);
  });

  it("returns true when condition is an empty string (not a valid path, treated as invalid)", () => {
    // Empty string is not null — it goes through JSONPath evaluation and returns false
    expect(evaluateCondition("", {})).toBe(false);
  });
});

describe("isDuplicate", () => {
  it("returns false when cache is null (no Redis configured)", async () => {
    expect(await isDuplicate(null, "org1", "corr1")).toBe(false);
  });

  it("returns false when correlationId is undefined (no dedup key)", async () => {
    // Pass a non-null mock so the correlationId guard is what triggers early return
    const mockCache = {} as Redis | null;
    expect(await isDuplicate(mockCache, "org1", undefined)).toBe(false);
  });

  it("returns false when event is new (first delivery)", async () => {
    const mockCache = {
      set: async () => "OK",
    } as unknown as Redis | null;
    expect(await isDuplicate(mockCache, "org1", "corr1")).toBe(false);
  });

  it("returns true when event is a duplicate (already seen)", async () => {
    const mockCache = {
      set: async () => null,
    } as unknown as Redis | null;
    expect(await isDuplicate(mockCache, "org1", "corr1")).toBe(true);
  });

  it("returns false when Redis throws (fail open)", async () => {
    const mockCache = {
      set: async () => {
        throw new Error("READONLY");
      },
    } as unknown as Redis | null;
    expect(await isDuplicate(mockCache, "org1", "corr1")).toBe(false);
  });
});

describe("applyTransform", () => {
  it("returns original data when transform is null", async () => {
    const data = { count: 5 };
    expect(await applyTransform(null, data)).toEqual(data);
  });

  it("transforms data with a JSONata expression", async () => {
    const data = { count: 5, price: 10 };
    const result = await applyTransform("{ 'total': count * price }", data);
    expect(result).toEqual({ total: 50 });
  });

  it("extracts a field with JSONata", async () => {
    const data = { user: { id: "u1", name: "Alice" } };
    const result = await applyTransform("user.id", data);
    expect(result).toBe("u1");
  });

  it("returns original data on invalid expression (safe fallback)", async () => {
    const data = { count: 5 };
    expect(await applyTransform("!!!invalid$$$", data)).toEqual(data);
  });
});

describe("normalizeToCloudEvent", () => {
  it("adds specversion if missing", () => {
    const event = {
      id: "e1",
      type: "task.created",
      source: "omni.runa",
      data: {},
      timestamp: "2026-01-01T00:00:00Z",
      organizationId: "org1",
    };
    const normalized = normalizeToCloudEvent(event);
    expect(normalized.specversion).toBe("1.0");
  });

  it("preserves existing specversion", () => {
    const event = {
      id: "e1",
      type: "task.created",
      source: "omni.runa",
      data: {},
      timestamp: "2026-01-01T00:00:00Z",
      organizationId: "org1",
      specversion: "1.0",
    };
    const normalized = normalizeToCloudEvent(event);
    expect(normalized.specversion).toBe("1.0");
  });

  it("sets time from timestamp if not present", () => {
    const event = {
      id: "e1",
      type: "task.created",
      source: "omni.runa",
      data: {},
      timestamp: "2026-01-01T00:00:00Z",
      organizationId: "org1",
    };
    const normalized = normalizeToCloudEvent(event);
    expect(normalized.time).toBe("2026-01-01T00:00:00Z");
  });

  it("sets omniorgid from organizationId", () => {
    const event = {
      id: "e1",
      type: "task.created",
      source: "omni.runa",
      data: {},
      timestamp: "2026-01-01T00:00:00Z",
      organizationId: "org1",
    };
    const normalized = normalizeToCloudEvent(event);
    expect(normalized.omniorgid).toBe("org1");
  });

  it("defaults datacontenttype to application/json", () => {
    const event = {
      id: "e1",
      type: "task.created",
      source: "omni.runa",
      data: {},
      timestamp: "2026-01-01T00:00:00Z",
      organizationId: "org1",
    };
    const normalized = normalizeToCloudEvent(event);
    expect(normalized.datacontenttype).toBe("application/json");
  });
});
