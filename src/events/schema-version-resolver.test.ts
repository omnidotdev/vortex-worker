import { describe, expect, it } from "bun:test";

import {
  buildMigrationChain,
  resolveSchemaVersion,
} from "./schema-version-resolver";

import type { VersionedSchema } from "./schema-version-resolver";

const v1Schema: VersionedSchema = {
  id: "v1-id",
  name: "task.created",
  version: 1,
  compatibilityMode: "backward",
  previousVersionId: null,
  migrationTransform: null,
  payloadSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
};

const v2Schema: VersionedSchema = {
  id: "v2-id",
  name: "task.created",
  version: 2,
  compatibilityMode: "backward",
  previousVersionId: "v1-id",
  migrationTransform: '{ "title": title, "priority": "medium" }',
  payloadSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      priority: { type: "string" },
    },
    required: ["title", "priority"],
  },
};

const v3Schema: VersionedSchema = {
  id: "v3-id",
  name: "task.created",
  version: 3,
  compatibilityMode: "backward",
  previousVersionId: "v2-id",
  migrationTransform:
    '{ "title": title, "priority": priority, "status": "open" }',
  payloadSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      priority: { type: "string" },
      status: { type: "string" },
    },
    required: ["title", "priority", "status"],
  },
};

describe("buildMigrationChain", () => {
  it("returns empty chain when source equals target", () => {
    const chain = buildMigrationChain([v1Schema], 1, 1);
    expect(chain).toEqual([]);
  });

  it("returns single-step chain for adjacent versions", () => {
    const chain = buildMigrationChain([v1Schema, v2Schema], 1, 2);
    expect(chain).not.toBeNull();
    expect(chain).toHaveLength(1);
    expect(chain![0].fromVersion).toBe(1);
    expect(chain![0].toVersion).toBe(2);
    expect(chain![0].transform).toBe(v2Schema.migrationTransform!);
  });

  it("returns multi-step chain for non-adjacent versions", () => {
    const chain = buildMigrationChain([v1Schema, v2Schema, v3Schema], 1, 3);
    expect(chain).not.toBeNull();
    expect(chain).toHaveLength(2);
    expect(chain![0].fromVersion).toBe(1);
    expect(chain![0].toVersion).toBe(2);
    expect(chain![1].fromVersion).toBe(2);
    expect(chain![1].toVersion).toBe(3);
  });

  it("returns null when chain is broken (missing transform)", () => {
    const v2NoTransform = { ...v2Schema, migrationTransform: null };
    const chain = buildMigrationChain(
      [v1Schema, v2NoTransform, v3Schema],
      1,
      3,
    );
    expect(chain).toBeNull();
  });

  it("returns null when target version does not exist", () => {
    const chain = buildMigrationChain([v1Schema], 1, 5);
    expect(chain).toBeNull();
  });

  it("returns null for downgrade (fromVersion > toVersion)", () => {
    const chain = buildMigrationChain([v1Schema, v2Schema, v3Schema], 3, 1);
    expect(chain).toBeNull();
  });
});

describe("resolveSchemaVersion", () => {
  it("returns data unchanged when versions match", async () => {
    const result = await resolveSchemaVersion({ title: "hello" }, 1, 1, [
      v1Schema,
    ]);
    expect(result.data).toEqual({ title: "hello" });
    expect(result.migrated).toBe(false);
  });

  it("migrates data through single version step", async () => {
    const result = await resolveSchemaVersion({ title: "hello" }, 1, 2, [
      v1Schema,
      v2Schema,
    ]);
    expect(result.migrated).toBe(true);
    expect(result.data).toEqual({ title: "hello", priority: "medium" });
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(2);
  });

  it("migrates data through multiple version steps", async () => {
    const result = await resolveSchemaVersion({ title: "hello" }, 1, 3, [
      v1Schema,
      v2Schema,
      v3Schema,
    ]);
    expect(result.migrated).toBe(true);
    expect(result.data).toEqual({
      title: "hello",
      priority: "medium",
      status: "open",
    });
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(3);
  });

  it("returns error when migration chain is broken", async () => {
    const v2NoTransform = { ...v2Schema, migrationTransform: null };
    const result = await resolveSchemaVersion({ title: "hello" }, 1, 3, [
      v1Schema,
      v2NoTransform,
      v3Schema,
    ]);
    expect(result.migrated).toBe(false);
    expect(result.error).toContain("No migration path");
  });

  it("passes through when compatibility mode is backward and no transform", async () => {
    const v2NoTransform = { ...v2Schema, migrationTransform: null };
    const result = await resolveSchemaVersion({ title: "hello" }, 1, 2, [
      v1Schema,
      v2NoTransform,
    ]);
    expect(result.migrated).toBe(false);
    expect(result.data).toEqual({ title: "hello" });
    expect(result.passthrough).toBe(true);
  });
});
