import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";

import EdgeDispatcher from "./edge-dispatcher";

const originalFetch = globalThis.fetch;

let fetchMock: ReturnType<typeof mock>;

beforeEach(() => {
  fetchMock = mock();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("EdgeDispatcher", () => {
  const config = { baseUrl: "https://spin.example.com" };

  it("calls the Spin function endpoint with correct URL and body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: "ok" }), { status: 200 }),
    );

    const dispatcher = new EdgeDispatcher(config);
    await dispatcher.dispatch("my-plugin", { foo: "bar" });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://spin.example.com/my-plugin");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ foo: "bar" }));
  });

  it("returns success with parsed JSON output", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ value: 42 }), { status: 200 }),
    );

    const dispatcher = new EdgeDispatcher(config);
    const result = await dispatcher.dispatch("my-plugin", { input: true });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ value: 42 });
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns error on non-200 response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const dispatcher = new EdgeDispatcher(config);
    const result = await dispatcher.dispatch("failing-plugin", {});

    expect(result.success).toBe(false);
    expect(result.error).toBe("Edge function returned status 500");
    expect(result.output).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns error on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch failed"));

    const dispatcher = new EdgeDispatcher(config);
    const result = await dispatcher.dispatch("unreachable-plugin", {});

    expect(result.success).toBe(false);
    expect(result.error).toBe("fetch failed");
    expect(result.output).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns error on timeout", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("signal timed out", "TimeoutError"));

    const dispatcher = new EdgeDispatcher({ ...config, timeoutMs: 100 });
    const result = await dispatcher.dispatch("slow-plugin", {});

    expect(result.success).toBe(false);
    expect(result.error).toBe("signal timed out");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes AbortSignal.timeout to fetch", async () => {
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(
      new AbortController().signal,
    );

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const dispatcher = new EdgeDispatcher({ ...config, timeoutMs: 3000 });
    await dispatcher.dispatch("plugin", {});

    expect(timeoutSpy).toHaveBeenCalledWith(3000);
    timeoutSpy.mockRestore();
  });

  it("uses default timeout when none provided", async () => {
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(
      new AbortController().signal,
    );

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const dispatcher = new EdgeDispatcher(config);
    await dispatcher.dispatch("plugin", {});

    expect(timeoutSpy).toHaveBeenCalledWith(5000);
    timeoutSpy.mockRestore();
  });

  it("strips trailing slash from baseUrl", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const dispatcher = new EdgeDispatcher({
      baseUrl: "https://spin.example.com/",
    });
    await dispatcher.dispatch("plugin-id", {});

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://spin.example.com/plugin-id");
  });
});
