/**
 * SSRF protection utility.
 *
 * Validates URLs and raw hosts against private/internal network ranges to
 * prevent Server-Side Request Forgery attacks. The literal-host checks are
 * synchronous; the resolved-host checks perform DNS resolution so a public
 * hostname that resolves to an internal address (DNS rebinding) is rejected
 * as well.
 */

import { resolve4, resolve6 } from "node:dns/promises";

/**
 * Private/internal IPv4 CIDR ranges that must not be reachable from outbound
 * requests (SSRF protection), expressed as unsigned 32-bit base/mask pairs.
 */
const BLOCKED_CIDRS: Array<{ base: number; mask: number }> = [
  // 0.0.0.0/8 (this host)
  { base: 0x00000000, mask: 0xff000000 },
  // 127.0.0.0/8
  { base: 0x7f000000, mask: 0xff000000 },
  // 10.0.0.0/8
  { base: 0x0a000000, mask: 0xff000000 },
  // 172.16.0.0/12
  { base: 0xac100000, mask: 0xfff00000 },
  // 192.168.0.0/16
  { base: 0xc0a80000, mask: 0xffff0000 },
  // 169.254.0.0/16 (link-local, includes cloud metadata 169.254.169.254)
  { base: 0xa9fe0000, mask: 0xffff0000 },
  // 100.64.0.0/10 (carrier-grade NAT)
  { base: 0x64400000, mask: 0xffc00000 },
];

const BLOCKED_HOSTNAME_SUFFIXES = [
  ".svc",
  ".cluster.local",
  ".local",
  ".internal",
];

/** Parse a dotted-quad IPv4 string into an unsigned 32-bit integer */
const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const octet = Number(p);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
};

/** Returns true if the unsigned 32-bit IPv4 integer falls in a blocked CIDR */
const isBlockedIpv4Int = (ip: number): boolean => {
  for (const { base, mask } of BLOCKED_CIDRS) {
    // Coerce to unsigned: bitwise `&` yields a signed int32, but the CIDR
    // bases above 2^31 (172.16/12, 192.168/16, 169.254/16) are unsigned
    if ((ip & mask) >>> 0 === base) return true;
  }
  return false;
};

/** Returns true if a dotted-quad IPv4 string is a blocked address */
const isBlockedIpv4 = (host: string): boolean => {
  const ip = ipv4ToInt(host);
  return ip !== null && isBlockedIpv4Int(ip);
};

/**
 * Returns true if an IPv6 address (optionally bracketed / zoned) is a blocked
 * internal address, including IPv4-mapped forms such as `::ffff:169.254.169.254`
 * that would otherwise bypass an IPv4-only check.
 */
const isBlockedIpv6 = (rawHost: string): boolean => {
  let host = rawHost;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // Strip a zone id (e.g. fe80::1%eth0)
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  host = host.toLowerCase();

  if (!host.includes(":")) return false;

  // Unspecified and loopback
  if (host === "::" || host === "::1") return true;

  // IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) embeddings
  const embedded = host.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embedded && isBlockedIpv4(embedded[1])) return true;

  // ::ffff:a9fe:a9fe style hex-mapped IPv4 (169.254.169.254 -> a9fe:a9fe)
  const hexMapped = host.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1], 16);
    const lo = Number.parseInt(hexMapped[2], 16);
    if (Number.isInteger(hi) && Number.isInteger(lo)) {
      const asV4 = ((hi << 16) | lo) >>> 0;
      if (isBlockedIpv4Int(asV4)) return true;
    }
  }

  // Unique local address fc00::/7 (fc.. and fd..)
  if (/^f[cd][0-9a-f]*:/.test(host)) return true;

  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]*:/.test(host)) return true;

  return false;
};

/** Returns true if a bare hostname string is a reserved/internal name */
const isBlockedHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  if (host === "localhost") return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some(
    (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
  );
};

/** Returns true if an IP literal (v4 or v6) is a blocked internal address */
const isBlockedIp = (ip: string): boolean =>
  isBlockedIpv4(ip) || isBlockedIpv6(ip);

/**
 * Returns true if the URL targets a private/internal address by its LITERAL
 * host (no DNS resolution). Covers localhost, reserved hostname suffixes, and
 * raw IPv4/IPv6 literals including IPv4-mapped IPv6.
 */
export const isBlockedUrl = (url: URL): boolean => {
  // URL.hostname keeps IPv6 literals bracketed; normalize for the checks below
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isBlockedHostname(hostname)) return true;
  if (isBlockedIpv4(hostname)) return true;
  if (isBlockedIpv6(url.hostname.toLowerCase())) return true;
  return false;
};

/** Resolve both A and AAAA records for a hostname, ignoring lookup misses */
const resolveHost = async (hostname: string): Promise<string[]> => {
  const ips: string[] = [];
  try {
    ips.push(...(await resolve4(hostname)));
  } catch {
    // No A records
  }
  try {
    ips.push(...(await resolve6(hostname)));
  } catch {
    // No AAAA records
  }
  return ips;
};

/**
 * Validate a URL string for SSRF safety by its literal host only.
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

/**
 * Validate a URL string for SSRF safety, resolving the hostname via DNS and
 * rejecting the request if ANY resolved address is private/internal. This is
 * the guard that defeats DNS rebinding, where a public hostname resolves to
 * an internal IP. Use it on every outbound request and on every redirect hop.
 */
export async function assertSafeResolvedUrl(urlStr: string): Promise<URL> {
  const url = assertSafeUrl(urlStr);

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  // A literal IP was already validated by assertSafeUrl; no DNS needed
  if (ipv4ToInt(hostname) !== null || hostname.includes(":")) return url;

  const ips = await resolveHost(hostname);
  if (ips.length === 0) {
    throw new Error(`Could not resolve host: ${hostname}`);
  }
  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      throw new Error(
        `Blocked request to private/internal address: ${hostname} resolves to ${ip}`,
      );
    }
  }

  return url;
}

/**
 * Validate a raw host (and optional port) for SSRF safety before a non-HTTP
 * egress such as SSH, FTP, or a database/redis connection. Resolves the host
 * via DNS and rejects any private/internal resolution.
 */
export async function assertSafeHost(host: string): Promise<void> {
  if (!host || typeof host !== "string" || !host.trim()) {
    throw new Error("Host is required");
  }

  const hostname = host
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();

  if (isBlockedHostname(hostname) || isBlockedIp(hostname)) {
    throw new Error(`Blocked connection to private/internal host: ${hostname}`);
  }

  // A literal IP was validated above; only hostnames need DNS resolution
  if (ipv4ToInt(hostname) !== null || hostname.includes(":")) return;

  const ips = await resolveHost(hostname);
  if (ips.length === 0) {
    throw new Error(`Could not resolve host: ${hostname}`);
  }
  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      throw new Error(
        `Blocked connection to private/internal host: ${hostname} resolves to ${ip}`,
      );
    }
  }
}
