/**
 * HTTP builtin SSRF tests.
 *
 * Verifies the HTTP request plugin validates the RESOLVED address (defeating
 * DNS rebinding), rejects IPv6-mapped internal literals, and re-validates
 * every redirect hop instead of blindly following a 3xx to an internal IP.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { httpPlugin } from "./http";

const request = httpPlugin.actions.request.handler;

describe("http builtin SSRF protection", () => {
  afterEach(() => {
    // Restore any fetch spies installed by individual tests
    spyOn(globalThis, "fetch").mockRestore();
  });

  it("blocks a public hostname that resolves to loopback (DNS rebinding)", async () => {
    // localtest.me is a public DNS name that resolves to 127.0.0.1
    const result = await request({ url: "http://localtest.me/" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("private/internal");
  });

  it("blocks an IPv4-mapped IPv6 metadata literal", async () => {
    const result = await request({
      url: "http://[::ffff:169.254.169.254]/latest/meta-data",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("private/internal");
  });

  it("blocks a direct link-local metadata literal", async () => {
    const result = await request({
      url: "http://169.254.169.254/latest/meta-data",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("private/internal");
  });

  it("re-validates redirect hops and blocks a redirect to an internal IP", async () => {
    // Public initial target, but the server 302-redirects to metadata. The
    // guard must catch the hop rather than following it blindly
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      }),
    );

    const result = await request({
      url: "https://example.com/",
      followRedirects: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("private/internal");
    // The first (public) hop was fetched; the internal redirect was never followed
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
