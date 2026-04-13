import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

import { withRetry } from "./dlq";

// Use short delays for tests
const TEST_CONFIG = { maxAttempts: 3, baseDelayMs: 10 };

// Mock Bun.sleep to avoid actual delays in tests
const sleepSpy = spyOn(Bun, "sleep").mockResolvedValue(undefined);

afterEach(() => {
  sleepSpy.mockClear();
});

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = mock(() => Promise.resolve("ok"));

    const result = await withRetry(fn, TEST_CONFIG);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it("retries on failure and succeeds on later attempt", async () => {
    let attempt = 0;
    const fn = mock(() => {
      attempt++;
      if (attempt < 3) throw new Error(`fail-${attempt}`);
      return Promise.resolve("recovered");
    });

    const result = await withRetry(fn, TEST_CONFIG);

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });

  it("throws after max attempts exhausted", async () => {
    const fn = mock(() => Promise.reject(new Error("persistent failure")));

    await expect(withRetry(fn, TEST_CONFIG)).rejects.toThrow(
      "persistent failure",
    );

    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });

  it("uses correct exponential delay pattern", async () => {
    const fn = mock(() => Promise.reject(new Error("fail")));

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1_000 }),
    ).rejects.toThrow("fail");

    // Delays: 1000 * 4^0 = 1000, 1000 * 4^1 = 4000
    expect(sleepSpy).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 1_000);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 4_000);
  });

  it("uses default config when none provided", async () => {
    const fn = mock(() => Promise.reject(new Error("fail")));

    await expect(withRetry(fn)).rejects.toThrow("fail");

    // Default: maxAttempts=3, baseDelayMs=1000
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 1_000);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 4_000);
  });

  it("succeeds on second attempt", async () => {
    let called = 0;
    const fn = mock(() => {
      called++;
      if (called === 1) throw new Error("transient");
      return Promise.resolve(42);
    });

    const result = await withRetry(fn, TEST_CONFIG);

    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
  });
});
