/**
 * Reject if `operation` does not settle within `ms` milliseconds.
 *
 * The Iggy client's `topic.list` / `message.poll` calls can hang indefinitely
 * on an unhealthy TCP connection (no client-side timeout). Because the consumer
 * polls in a single sequential loop, one hung call freezes the whole consumer.
 * Racing each call against a timer guarantees it always settles, so the loop
 * can log, reconnect, and continue on the next cycle instead of stalling
 * forever.
 */
export const withTimeout = <T>(
  operation: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`Iggy operation '${label}' timed out after ${ms}ms`)),
      ms,
    );
  });

  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
};
