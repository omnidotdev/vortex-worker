/**
 * SSRF-guarded fetch for the Worker sandbox.
 *
 * The Worker sandbox (see `sandbox/runner.ts`) executes tenant-authored code
 * and exposes `fetch` so that code can reach external services. To stop that
 * code from probing the cluster's internal network (SSRF), the exposed fetch
 * validates every target URL against private/internal ranges and rejects
 * disallowed schemes before delegating to the real fetch.
 *
 * This factory is deliberately self-contained (no module-level references) so
 * that `createGuardedFetch.toString()` can be embedded verbatim into the
 * generated Worker source, where parent-module imports are unavailable. The
 * same function is unit-tested directly in-process, so the embedded code path
 * and the tested code path are identical.
 */

/**
 * Wrap a fetch implementation with SSRF validation.
 *
 * @param realFetch - The underlying fetch to delegate to once a URL is allowed
 * @returns A fetch-compatible function that rejects internal/unsafe targets
 */
export const createGuardedFetch = (realFetch: typeof fetch): typeof fetch => {
  // Private/internal IPv4 CIDR ranges, as { base, mask } in unsigned 32-bit
  const blockedCidrs: Array<{ base: number; mask: number }> = [
    { base: 0x7f000000, mask: 0xff000000 }, // 127.0.0.0/8
    { base: 0x0a000000, mask: 0xff000000 }, // 10.0.0.0/8
    { base: 0xac100000, mask: 0xfff00000 }, // 172.16.0.0/12
    { base: 0xc0a80000, mask: 0xffff0000 }, // 192.168.0.0/16
    { base: 0xa9fe0000, mask: 0xffff0000 }, // 169.254.0.0/16 (link-local)
  ];
  const blockedSuffixes = [".svc", ".cluster.local"];

  const ipToInt = (ip: string): number | null => {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
      const octet = Number(p);
      if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
      n = (n << 8) | octet;
    }
    return n >>> 0;
  };

  const isBlockedHost = (hostname: string): boolean => {
    const host = hostname.toLowerCase();
    if (host === "localhost" || host === "[::1]") return true;
    if (
      blockedSuffixes.some(
        (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
      )
    )
      return true;
    const ip = ipToInt(host);
    if (ip !== null) {
      for (const { base, mask } of blockedCidrs) {
        // Coerce to unsigned: bitwise `&` yields a signed int32, but the CIDR
        // bases above 2^31 (172.16/12, 192.168/16, 169.254/16) are unsigned
        if ((ip & mask) >>> 0 === base) return true;
      }
    }
    return false;
  };

  const assertSafeUrl = (urlStr: string): void => {
    const url = new URL(urlStr);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`Blocked request to unsupported scheme: ${url.protocol}`);
    }
    if (isBlockedHost(url.hostname)) {
      throw new Error(
        `Blocked request to private/internal address: ${url.hostname}`,
      );
    }
  };

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    assertSafeUrl(target);
    return realFetch(input, init);
  }) as typeof fetch;
};
