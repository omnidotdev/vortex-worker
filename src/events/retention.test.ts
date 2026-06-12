import { describe, expect, test } from "bun:test";

import { RETENTION_MICROSECONDS } from "./retention";

/**
 * Iggy's topic `messageExpiry` is expressed in MICROSECONDS. Passing the raw
 * second count (7,776,000 for 90 days) made the server interpret it as ~7.776s,
 * silently deleting events before the consumer could read them.
 */
describe("topic retention", () => {
  test("is 90 days expressed in microseconds (Iggy's unit)", () => {
    const ninetyDaysMicros = 90n * 24n * 60n * 60n * 1_000_000n;
    expect(RETENTION_MICROSECONDS).toBe(ninetyDaysMicros);
  });
});
