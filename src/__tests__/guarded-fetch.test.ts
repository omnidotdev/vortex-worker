/**
 * Guarded fetch tests.
 *
 * The sandbox exposes `fetch` to user code, wrapped in an SSRF guard that
 * rejects private/internal addresses and non-http(s) schemes before any
 * request leaves the worker. The same factory is embedded into the Worker
 * source via `.toString()`, so these in-process tests exercise the exact
 * code path that runs inside the sandbox.
 */

import { describe, expect, it } from "bun:test";

import { createGuardedFetch } from "../sandbox/guardedFetch";

const okResponse = { status: 200 } as unknown as Response;

describe("createGuardedFetch", () => {
  it("calls through to the underlying fetch for public URLs", async () => {
    const calls: Array<[string | URL, RequestInit | undefined]> = [];
    const realFetch = async (url: string | URL, init?: RequestInit) => {
      calls.push([url, init]);
      return okResponse;
    };

    const guarded = createGuardedFetch(realFetch as unknown as typeof fetch);
    const res = await guarded("https://api.example.com/send", {
      method: "POST",
    });

    expect(res).toBe(okResponse);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("https://api.example.com/send");
    expect(calls[0]?.[1]).toEqual({ method: "POST" });
  });

  it("accepts a URL object for a public address", async () => {
    let called = false;
    const realFetch = async () => {
      called = true;
      return okResponse;
    };

    const guarded = createGuardedFetch(realFetch as unknown as typeof fetch);
    await guarded(new URL("https://example.com/"));

    expect(called).toBe(true);
  });

  it("blocks requests to private 10.0.0.0/8 addresses", async () => {
    let called = false;
    const realFetch = async () => {
      called = true;
      return okResponse;
    };

    const guarded = createGuardedFetch(realFetch as unknown as typeof fetch);

    await expect(guarded("http://10.0.1.10:30501/")).rejects.toThrow(
      /private\/internal/,
    );
    expect(called).toBe(false);
  });

  it("blocks requests to localhost", async () => {
    const guarded = createGuardedFetch(
      (async () => okResponse) as unknown as typeof fetch,
    );
    await expect(guarded("http://localhost:5432/")).rejects.toThrow(
      /private\/internal/,
    );
  });

  it("blocks the cloud metadata link-local address", async () => {
    const guarded = createGuardedFetch(
      (async () => okResponse) as unknown as typeof fetch,
    );
    await expect(
      guarded("http://169.254.169.254/latest/meta-data"),
    ).rejects.toThrow(/private\/internal/);
  });

  it("blocks in-cluster .svc.cluster.local hostnames", async () => {
    const guarded = createGuardedFetch(
      (async () => okResponse) as unknown as typeof fetch,
    );
    await expect(
      guarded("http://herald-api.fractal-herald.svc.cluster.local:4000/"),
    ).rejects.toThrow(/private\/internal/);
  });

  it("blocks non-http(s) schemes", async () => {
    let called = false;
    const guarded = createGuardedFetch((async () => {
      called = true;
      return okResponse;
    }) as unknown as typeof fetch);

    await expect(guarded("file:///etc/passwd")).rejects.toThrow(/scheme/);
    expect(called).toBe(false);
  });
});
