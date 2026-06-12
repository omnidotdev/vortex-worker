import { describe, expect, test } from "bun:test";

import { withTimeout } from "./withTimeout";

describe("withTimeout", () => {
  test("resolves with the value when the operation settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 100, "op")).resolves.toBe(42);
  });

  test("rejects when the operation hangs past the deadline", async () => {
    // A promise that never settles, simulating a hung Iggy poll
    const hung = new Promise<never>(() => {});
    await expect(withTimeout(hung, 10, "poll")).rejects.toThrow(
      /'poll' timed out after 10ms/,
    );
  });
});
