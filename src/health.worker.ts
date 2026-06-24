/**
 * Health-check worker thread.
 *
 * Runs on its own event loop so Iggy's blocking TCP I/O in the main thread
 * never prevents the kubelet probe from getting a response. /health and /ready
 * are answered instantly from shared state; all other requests are proxied
 * to the main thread's API server on HEALTH_PORT+1.
 */

const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? "8080");
const API_PORT = HEALTH_PORT + 1;
const PROXY_TIMEOUT_MS = 30_000;

let state = {
  hatchetReady: false,
  executorEverReady: false,
  executorInitFailed: false,
  hasExecutor: false,
  // Set when HATCHET_CLIENT_TOKEN is decodably expired at boot. Forces /ready to
  // fail so the pod is marked unready and alerts fire, rather than silently
  // dead-lettering every dispatched event.
  hatchetTokenExpired: false,
};

Bun.serve({
  port: HEALTH_PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({
        status:
          state.executorEverReady &&
          state.hatchetReady &&
          !state.hatchetTokenExpired
            ? "ok"
            : "degraded",
        timestamp: Date.now(),
        service: "vortex-worker",
        hatchetToken: state.hatchetTokenExpired ? "expired" : "ok",
        hatchet: state.hatchetReady ? "connected" : "initializing",
        executor: state.hasExecutor
          ? state.executorEverReady
            ? "ok"
            : "unreachable"
          : state.executorInitFailed
            ? "init_failed"
            : "initializing",
      });
    }

    if (url.pathname === "/ready") {
      const isReady =
        state.hatchetReady &&
        state.executorEverReady &&
        !state.hatchetTokenExpired;
      return Response.json(
        {
          ready: isReady,
          timestamp: Date.now(),
          service: "vortex-worker",
          hatchetToken: state.hatchetTokenExpired ? "expired" : "ok",
          hatchet: state.hatchetReady ? "connected" : "initializing",
          executor: state.hasExecutor
            ? state.executorEverReady
              ? "ok"
              : "unreachable"
            : state.executorInitFailed
              ? "init_failed"
              : "initializing",
        },
        { status: isReady ? 200 : 503 },
      );
    }

    // Proxy all other requests to the main thread's API server
    const proxyUrl = new URL(req.url);
    proxyUrl.hostname = "127.0.0.1";
    proxyUrl.port = String(API_PORT);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PROXY_TIMEOUT_MS);
    try {
      const proxied = await fetch(proxyUrl.toString(), {
        method: req.method,
        headers: req.headers,
        body:
          req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
        signal: ac.signal,
      });
      return new Response(proxied.body, {
        status: proxied.status,
        headers: proxied.headers,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return Response.json({ error: "Proxy timeout" }, { status: 504 });
      }
      return Response.json({ error: "Service unavailable" }, { status: 503 });
    } finally {
      clearTimeout(timer);
    }
  },
});

self.onmessage = (event: MessageEvent<Partial<typeof state>>) => {
  state = { ...state, ...event.data };
};
