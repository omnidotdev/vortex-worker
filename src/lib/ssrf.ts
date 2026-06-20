/**
 * SSRF protection utility.
 *
 * Validates URLs against private/internal network ranges to prevent
 * Server-Side Request Forgery attacks.
 */

/**
 * Private/internal IPv4 CIDR ranges and reserved hostnames that must
 * not be reachable from outbound requests (SSRF protection).
 */
const BLOCKED_CIDRS: Array<{ base: number; mask: number }> = [
  // 127.0.0.0/8
  { base: 0x7f000000, mask: 0xff000000 },
  // 10.0.0.0/8
  { base: 0x0a000000, mask: 0xff000000 },
  // 172.16.0.0/12
  { base: 0xac100000, mask: 0xfff00000 },
  // 192.168.0.0/16
  { base: 0xc0a80000, mask: 0xffff0000 },
  // 169.254.0.0/16 (link-local)
  { base: 0xa9fe0000, mask: 0xffff0000 },
];

const BLOCKED_HOSTNAME_SUFFIXES = [".svc", ".cluster.local"];

const ipToInt = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const octet = Number(p);
    if (Number.isNaN(octet) || octet < 0 || octet > 255) return null;
    n = (n << 8) | octet;
  }
  // Convert to unsigned 32-bit
  return n >>> 0;
};

/**
 * Returns true if the URL targets a private/internal network address.
 */
export const isBlockedUrl = (url: URL): boolean => {
  const hostname = url.hostname.toLowerCase();

  // Block localhost variants
  if (hostname === "localhost" || hostname === "[::1]") return true;

  // Block internal K8s hostnames
  if (
    BLOCKED_HOSTNAME_SUFFIXES.some(
      (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
    )
  )
    return true;

  // Check if hostname is a raw IPv4 address in a blocked CIDR
  const ip = ipToInt(hostname);
  if (ip !== null) {
    for (const { base, mask } of BLOCKED_CIDRS) {
      // Coerce to unsigned: bitwise `&` yields a signed int32, but the CIDR
      // bases above 2^31 (172.16/12, 192.168/16, 169.254/16) are unsigned
      if ((ip & mask) >>> 0 === base) return true;
    }
  }

  return false;
};

/**
 * Validate a URL string for SSRF safety.
 * Throws if the URL targets a blocked address or uses a disallowed scheme.
 */
export function assertSafeUrl(urlStr: string): URL {
  const url = new URL(urlStr);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Blocked request to unsupported scheme: ${url.protocol}`);
  }

  if (isBlockedUrl(url)) {
    throw new Error(
      `Blocked request to private/internal address: ${url.hostname}`,
    );
  }

  return url;
}
