/**
 * Iggy topic message retention.
 *
 * Iggy's topic `messageExpiry` is expressed in MICROSECONDS. Passing the raw
 * second count made the server interpret it as ~7.776s, silently deleting
 * events before the consumer could read them, so the value handed to Iggy must
 * be scaled to microseconds.
 */

/** Retention window in seconds (90 days). */
const RETENTION_SECONDS = 90 * 24 * 60 * 60;

/** Same window in microseconds, the unit Iggy's `messageExpiry` expects. */
export const RETENTION_MICROSECONDS = BigInt(RETENTION_SECONDS) * 1_000_000n;
