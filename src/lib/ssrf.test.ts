/**
 * SSRF protection tests.
 *
 * Covers the private/internal ranges the guard must block, including the
 * ranges whose CIDR base exceeds 2^31 (172.16/12, 192.168/16, 169.254/16),
 * which a signed-int32 mask comparison silently fails to match.
 */

import { describe, expect, it } from "bun:test";

import {
  assertSafeHost,
  assertSafeResolvedUrl,
  assertSafeUrl,
  isBlockedUrl,
} from "./ssrf";

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

describe("isBlockedUrl IPv6 and mapped bypasses", () => {
  const blocked = [
    "http://[::1]/",
    "http://[::ffff:169.254.169.254]/latest/meta-data",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[fd00::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://0.0.0.0/",
    "http://100.64.1.1/",
  ];
  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(isBlockedUrl(new URL(url))).toBe(true);
    });
  }

  const allowed = [
    "http://[2606:4700:4700::1111]/",
    "https://[2001:4860:4860::8888]/",
  ];
  for (const url of allowed) {
    it(`allows public IPv6 ${url}`, () => {
      expect(isBlockedUrl(new URL(url))).toBe(false);
    });
  }
});

describe("assertSafeResolvedUrl (DNS rebinding)", () => {
  it("rejects a public hostname that resolves to loopback", async () => {
    // localtest.me is a real public DNS name that resolves to 127.0.0.1
    await expect(assertSafeResolvedUrl("http://localtest.me/")).rejects.toThrow(
      /private\/internal/,
    );
  });

  it("rejects an IPv4-mapped IPv6 metadata literal without DNS", async () => {
    await expect(
      assertSafeResolvedUrl("http://[::ffff:169.254.169.254]/"),
    ).rejects.toThrow(/private\/internal/);
  });

  it("allows a public host that resolves to a public IP", async () => {
    const url = await assertSafeResolvedUrl("https://example.com/");
    expect(url.hostname).toBe("example.com");
  });
});

describe("assertSafeHost (non-HTTP egress)", () => {
  it("rejects a literal private IPv4", async () => {
    await expect(assertSafeHost("10.0.0.5")).rejects.toThrow(
      /private\/internal/,
    );
  });

  it("rejects localhost", async () => {
    await expect(assertSafeHost("localhost")).rejects.toThrow(
      /private\/internal/,
    );
  });

  it("rejects a public host that resolves to loopback", async () => {
    await expect(assertSafeHost("localtest.me")).rejects.toThrow(
      /private\/internal/,
    );
  });

  it("rejects an IPv4-mapped IPv6 metadata literal", async () => {
    await expect(assertSafeHost("::ffff:169.254.169.254")).rejects.toThrow(
      /private\/internal/,
    );
  });
});
