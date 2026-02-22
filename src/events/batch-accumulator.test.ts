import { afterEach, describe, expect, it, mock } from "bun:test";

// Stub lib/logger to prevent cross-test pollution from module mocks
mock.module("lib/logger", () => ({
  default: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

import BatchAccumulator from "./batch-accumulator";

import type { BatchMetadata } from "./batch-accumulator";

afterEach(() => {
  mock.restore();
});

describe("BatchAccumulator", () => {
  it("flushes when maxSize is reached", async () => {
    const flushed: { events: unknown[]; metadata: BatchMetadata }[] = [];
    const onFlush = mock(async (events: unknown[], metadata: BatchMetadata) => {
      flushed.push({ events, metadata });
    });

    const acc = new BatchAccumulator(
      "rule-1",
      { maxSize: 3, maxWaitMs: 60_000 },
      onFlush,
    );

    await acc.add({ id: 1 });
    await acc.add({ id: 2 });
    expect(onFlush).not.toHaveBeenCalled();

    await acc.add({ id: 3 });
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(flushed[0].events).toHaveLength(3);
    expect(flushed[0].events).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(flushed[0].metadata.size).toBe(3);

    // Clean up timers
    await acc.shutdown();
  });

  it("partitions events by key and only flushes the full partition", async () => {
    const flushed: { events: unknown[]; metadata: BatchMetadata }[] = [];
    const onFlush = mock(async (events: unknown[], metadata: BatchMetadata) => {
      flushed.push({ events, metadata });
    });

    const acc = new BatchAccumulator(
      "rule-2",
      { maxSize: 2, maxWaitMs: 60_000, partitionKey: "userId" },
      onFlush,
    );

    await acc.add({ userId: "a", value: 1 });
    await acc.add({ userId: "b", value: 2 });
    // Neither partition has 2 events yet
    expect(onFlush).not.toHaveBeenCalled();

    await acc.add({ userId: "a", value: 3 });
    // Partition "a" now has 2 events -> flush
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(flushed[0].events).toEqual([
      { userId: "a", value: 1 },
      { userId: "a", value: 3 },
    ]);
    expect(flushed[0].metadata.partitionKey).toBe("userId");
    expect(flushed[0].metadata.partitionValue).toBe("a");

    // Partition "b" still has only 1 event
    await acc.shutdown();
    // Shutdown should flush partition "b"
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(flushed[1].events).toEqual([{ userId: "b", value: 2 }]);
    expect(flushed[1].metadata.partitionValue).toBe("b");
  });

  it("flushes on timer when maxWaitMs elapses", async () => {
    const flushed: { events: unknown[]; metadata: BatchMetadata }[] = [];
    const onFlush = mock(async (events: unknown[], metadata: BatchMetadata) => {
      flushed.push({ events, metadata });
    });

    const acc = new BatchAccumulator(
      "rule-3",
      { maxSize: 100, maxWaitMs: 50 },
      onFlush,
    );

    await acc.add({ id: 1 });
    await acc.add({ id: 2 });
    expect(onFlush).not.toHaveBeenCalled();

    // Wait for the timer to fire
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(flushed[0].events).toHaveLength(2);
    expect(flushed[0].metadata.size).toBe(2);
  });

  it("shutdown flushes all partitions", async () => {
    const flushed: { events: unknown[]; metadata: BatchMetadata }[] = [];
    const onFlush = mock(async (events: unknown[], metadata: BatchMetadata) => {
      flushed.push({ events, metadata });
    });

    const acc = new BatchAccumulator(
      "rule-4",
      { maxSize: 100, maxWaitMs: 60_000, partitionKey: "team" },
      onFlush,
    );

    await acc.add({ team: "x", id: 1 });
    await acc.add({ team: "y", id: 2 });
    await acc.add({ team: "x", id: 3 });
    expect(onFlush).not.toHaveBeenCalled();

    await acc.shutdown();

    expect(onFlush).toHaveBeenCalledTimes(2);

    const teamX = flushed.find((f) => f.metadata.partitionValue === "x");
    const teamY = flushed.find((f) => f.metadata.partitionValue === "y");

    expect(teamX?.events).toHaveLength(2);
    expect(teamY?.events).toHaveLength(1);
  });

  it("uses default partition when partitionKey is missing from event", async () => {
    const flushed: { events: unknown[]; metadata: BatchMetadata }[] = [];
    const onFlush = mock(async (events: unknown[], metadata: BatchMetadata) => {
      flushed.push({ events, metadata });
    });

    const acc = new BatchAccumulator(
      "rule-5",
      { maxSize: 2, maxWaitMs: 60_000, partitionKey: "userId" },
      onFlush,
    );

    // Events without the userId field should go to the default partition
    await acc.add({ name: "event1" });
    await acc.add({ name: "event2" });

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(flushed[0].events).toHaveLength(2);
    expect(flushed[0].metadata.partitionValue).toBeUndefined();

    await acc.shutdown();
  });

  it("includes correct window timestamps in metadata", async () => {
    const flushed: { events: unknown[]; metadata: BatchMetadata }[] = [];
    const onFlush = mock(async (events: unknown[], metadata: BatchMetadata) => {
      flushed.push({ events, metadata });
    });

    const beforeAdd = new Date().toISOString();

    const acc = new BatchAccumulator(
      "rule-6",
      { maxSize: 2, maxWaitMs: 60_000 },
      onFlush,
    );

    await acc.add({ id: 1 });
    await acc.add({ id: 2 });

    const afterFlush = new Date().toISOString();

    expect(flushed[0].metadata.windowStart >= beforeAdd).toBe(true);
    expect(flushed[0].metadata.windowEnd <= afterFlush).toBe(true);
    expect(flushed[0].metadata.windowStart <= flushed[0].metadata.windowEnd).toBe(true);

    await acc.shutdown();
  });
});
