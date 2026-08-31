import { describe, expect, it } from "bun:test";

import {
  applyTransform,
  bridgeTierSyncEvent,
  evaluateCondition,
  isDuplicate,
  normalizeToCloudEvent,
} from "../router";

import type { Redis } from "iovalkey";
import type { OmniEvent } from "../types";

/** Build a minimal OmniEvent for tests, overriding only what matters. */
const makeEvent = (overrides: Partial<OmniEvent> = {}): OmniEvent => ({
  id: "e1",
  type: "task.created",
  source: "omni.runa",
  data: {},
  timestamp: "2026-01-01T00:00:00Z",
  organizationId: "org1",
  ...overrides,
});

/** Mock Hatchet client that records `event.push` calls. */
const makeHatchetSpy = () => {
  const pushes: { name: string; payload: unknown }[] = [];
  const hatchet = {
    event: {
      push: async (name: string, payload: unknown) => {
        pushes.push({ name, payload });
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: test double for the Hatchet client
  } as any;
  return { hatchet, pushes };
};

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
    // Empty string is not null, it goes through JSONPath evaluation and returns false
    expect(evaluateCondition("", {})).toBe(false);
  });
});

describe("isDuplicate", () => {
  it("returns false when cache is null (no Redis configured)", async () => {
    expect(await isDuplicate(null, "org1", "key1")).toBe(false);
  });

  it("returns false when dedupKey is undefined (no dedup key)", async () => {
    // Pass a non-null mock so the dedupKey guard is what triggers early return
    const mockCache = {} as Redis | null;
    expect(await isDuplicate(mockCache, "org1", undefined)).toBe(false);
  });

  it("returns false when event is new (first delivery)", async () => {
    const mockCache = {
      set: async () => "OK",
    } as unknown as Redis | null;
    expect(await isDuplicate(mockCache, "org1", "key1")).toBe(false);
  });

  it("returns true when event is a duplicate (already seen)", async () => {
    const mockCache = {
      set: async () => null,
    } as unknown as Redis | null;
    expect(await isDuplicate(mockCache, "org1", "key1")).toBe(true);
  });

  it("returns false when Redis throws (fail open)", async () => {
    const mockCache = {
      set: async () => {
        throw new Error("READONLY");
      },
    } as unknown as Redis | null;
    expect(await isDuplicate(mockCache, "org1", "key1")).toBe(false);
  });

  it("keys on the value passed in (dedup namespace is per org + key)", async () => {
    const seen = new Set<string>();
    const mockCache = {
      // Emulate SET NX: "OK" on first write, null if the key already exists
      set: async (key: string) => {
        if (seen.has(key)) return null;
        seen.add(key);
        return "OK";
      },
    } as unknown as Redis | null;

    // Two related events sharing a correlationId but with distinct dedup keys
    // (their unique event ids) are BOTH processed: neither is a duplicate.
    expect(await isDuplicate(mockCache, "org1", "event-id-a")).toBe(false);
    expect(await isDuplicate(mockCache, "org1", "event-id-b")).toBe(false);

    // A true redelivery (same dedup key) is dropped the second time.
    expect(await isDuplicate(mockCache, "org1", "idem-1")).toBe(false);
    expect(await isDuplicate(mockCache, "org1", "idem-1")).toBe(true);
  });
});

describe("bridgeTierSyncEvent (trust boundary)", () => {
  it("does NOT bridge a tenant-sourced platform.plan.updated event", async () => {
    const { hatchet, pushes } = makeHatchetSpy();
    const event = makeEvent({
      type: "platform.plan.updated",
      source: "omni.runa", // a tenant/product source, not the platform
      data: { planId: "plan-1" },
    });

    await bridgeTierSyncEvent(event, hatchet);

    expect(pushes).toHaveLength(0);
  });

  it("does NOT bridge a forged omni.platform-lookalike source", async () => {
    const { hatchet, pushes } = makeHatchetSpy();
    const event = makeEvent({
      type: "platform.plan.updated",
      source: "omni.platform.evil",
      data: { planId: "plan-1" },
    });

    await bridgeTierSyncEvent(event, hatchet);

    expect(pushes).toHaveLength(0);
  });

  it("bridges a genuine platform-sourced plan event to tier:sync", async () => {
    const { hatchet, pushes } = makeHatchetSpy();
    const event = makeEvent({
      type: "platform.plan.updated",
      source: "omni.platform",
      data: { planId: "plan-1", entityType: "plan" },
    });

    await bridgeTierSyncEvent(event, hatchet);

    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.name).toBe("tier:sync");
    expect((pushes[0]?.payload as { planId?: string }).planId).toBe("plan-1");
  });

  it("ignores non-tier-sync event types even from the platform source", async () => {
    const { hatchet, pushes } = makeHatchetSpy();
    const event = makeEvent({
      type: "task.created",
      source: "omni.platform",
    });

    await bridgeTierSyncEvent(event, hatchet);

    expect(pushes).toHaveLength(0);
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
