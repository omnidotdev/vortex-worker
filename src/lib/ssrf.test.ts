/**
 * SSRF protection tests.
 *
 * Covers the private/internal ranges the guard must block, including the
 * ranges whose CIDR base exceeds 2^31 (172.16/12, 192.168/16, 169.254/16),
 * which a signed-int32 mask comparison silently fails to match.
 */

import { describe, expect, it } from "bun:test";

import { assertSafeUrl, isBlockedUrl } from "./ssrf";

describe("isBlockedUrl", () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://10.0.1.10:30501/",
    "http://172.16.5.4/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://localhost:5432/",
    "http://herald-api.fractal-herald.svc.cluster.local:4000/",
  ];

  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(isBlockedUrl(new URL(url))).toBe(true);
    });
  }

  const allowed = [
    "https://api.example.com/send",
    "http://8.8.8.8/",
    "http://172.32.0.1/",
    "http://192.169.0.1/",
  ];

  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(isBlockedUrl(new URL(url))).toBe(false);
    });
  }
});

describe("assertSafeUrl", () => {
  it("returns the URL for a public https address", () => {
    expect(assertSafeUrl("https://example.com/x").hostname).toBe("example.com");
  });

  it("throws for a private/internal address", () => {
    expect(() => assertSafeUrl("http://192.168.0.5/")).toThrow(
      /private\/internal/,
    );
  });

  it("throws for an unsupported scheme", () => {
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow(/scheme/);
  });
});
