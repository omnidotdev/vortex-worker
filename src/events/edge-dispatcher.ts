/**
 * Edge dispatcher for routing event processing to Spin functions on SpinKube.
 *
 * Provides an HTTP client that dispatches plugin execution to edge-deployed
 * Spin functions, returning structured results with timing metadata.
 */

const DEFAULT_TIMEOUT_MS = 5_000;

type EdgeConfig = {
  /** Base URL for Spin function endpoints */
  baseUrl: string;
  /** Request timeout in ms (default: 5000) */
  timeoutMs?: number;
};

type DispatchResult = {
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
};

/**
 * Dispatch event processing to Spin functions running on SpinKube.
 *
 * POSTs JSON input to `${baseUrl}/${pluginId}` with a configurable timeout
 * via `AbortSignal.timeout`. Returns a `DispatchResult` with timing metadata
 * regardless of success or failure.
 */
class EdgeDispatcher {
  #baseUrl: string;
  #timeoutMs: number;

  constructor(config: EdgeConfig) {
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Dispatch input to a Spin function endpoint.
   * @param pluginId - Plugin identifier used as the URL path segment
   * @param input - JSON-serializable payload to send
   * @returns Dispatch result with success status, output or error, and timing
   */
  async dispatch(pluginId: string, input: unknown): Promise<DispatchResult> {
    const url = `${this.#baseUrl}/${pluginId}`;
    const start = performance.now();

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });

      const durationMs = performance.now() - start;

      if (!response.ok) {
        return {
          success: false,
          error: `Edge function returned status ${response.status}`,
          durationMs,
        };
      }

      const output: unknown = await response.json();

      return { success: true, output, durationMs };
    } catch (err) {
      const durationMs = performance.now() - start;

      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      };
    }
  }
}

export default EdgeDispatcher;

export type { DispatchResult, EdgeConfig };
