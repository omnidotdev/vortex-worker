/**
 * Built-in HTTP Request Plugin
 *
 * Provides HTTP request capabilities for workflows.
 * Supports GET, POST, PUT, PATCH, DELETE with headers, body, and auth.
 */

import { assertSafeResolvedUrl } from "lib/ssrf";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Maximum number of redirect hops to follow, each re-validated for SSRF */
const MAX_REDIRECTS = 5;

/** HTTP request input parameters */
export interface HttpRequestInput {
  /** Request URL (required) */
  url: string;
  /** HTTP method (default: GET) */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  /** Request headers */
  headers?: Record<string, string>;
  /** Request body (for POST, PUT, PATCH) */
  body?: unknown;
  /** Content type (default: application/json) */
  contentType?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Follow redirects (default: true) */
  followRedirects?: boolean;
  /** Basic auth credentials */
  auth?: {
    type: "basic" | "bearer";
    username?: string;
    password?: string;
    token?: string;
  };
}

/** HTTP response output */
export interface HttpResponseOutput {
  /** Response status code */
  status: number;
  /** Response status text */
  statusText: string;
  /** Response headers */
  headers: Record<string, string>;
  /** Response body (parsed as JSON if possible) */
  body: unknown;
  /** Whether the request was successful (2xx) */
  ok: boolean;
  /** Request duration in ms */
  durationMs: number;
}

/**
 * Execute an HTTP request.
 */
const executeRequest = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      url,
      method = "GET",
      headers = {},
      body,
      contentType = "application/json",
      timeout = 30000,
      followRedirects = true,
      auth,
    } = inputs as unknown as HttpRequestInput;

    if (!url || typeof url !== "string" || !url.trim()) {
      return {
        success: false,
        error: "URL is required (received empty or missing value)",
        durationMs: performance.now() - startTime,
      };
    }

    // Validate URL format before attempting fetch
    try {
      new URL(url);
    } catch {
      return {
        success: false,
        error: `Invalid URL: "${url}". Ensure the URL includes a scheme (https://) and is a valid address`,
        durationMs: performance.now() - startTime,
      };
    }

    // SSRF protection: validate the RESOLVED address (DNS) before requesting,
    // so a public hostname that resolves to an internal IP is rejected
    try {
      await assertSafeResolvedUrl(url);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: performance.now() - startTime,
      };
    }

    // Build headers
    const requestHeaders: Record<string, string> = {
      ...headers,
    };

    // Set content type for body requests
    if (body && !requestHeaders["Content-Type"]) {
      requestHeaders["Content-Type"] = contentType;
    }

    // Handle auth
    if (auth) {
      if (auth.type === "basic" && auth.username && auth.password) {
        const credentials = btoa(`${auth.username}:${auth.password}`);
        requestHeaders.Authorization = `Basic ${credentials}`;
      } else if (auth.type === "bearer" && auth.token) {
        requestHeaders.Authorization = `Bearer ${auth.token}`;
      }
    }

    // Build request body
    let requestBody: string | undefined;
    if (body !== undefined && method !== "GET" && method !== "HEAD") {
      requestBody = typeof body === "string" ? body : JSON.stringify(body);
    }

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // Follow redirects manually so every hop is re-validated for SSRF. The
      // browser "follow" mode would chase a 3xx Location to an internal IP
      // without any further check, defeating the initial validation
      let currentUrl = url;
      let redirectsLeft = followRedirects ? MAX_REDIRECTS : 0;
      let response = await fetch(currentUrl, {
        method,
        headers: requestHeaders,
        body: requestBody,
        signal: controller.signal,
        redirect: "manual",
      });

      while (
        redirectsLeft > 0 &&
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get("location")
      ) {
        const location = response.headers.get("location") as string;
        const nextUrl = new URL(location, currentUrl).href;

        // Re-validate the resolved target of every redirect hop
        await assertSafeResolvedUrl(nextUrl);

        currentUrl = nextUrl;
        redirectsLeft -= 1;
        response = await fetch(currentUrl, {
          method,
          headers: requestHeaders,
          body: requestBody,
          signal: controller.signal,
          redirect: "manual",
        });
      }

      clearTimeout(timeoutId);

      // Parse response headers
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // Parse response body
      let responseBody: unknown;
      const responseContentType = response.headers.get("content-type") || "";

      if (responseContentType.includes("application/json")) {
        try {
          responseBody = await response.json();
        } catch {
          responseBody = await response.text();
        }
      } else {
        responseBody = await response.text();
      }

      const output: HttpResponseOutput = {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseBody,
        ok: response.ok,
        durationMs: performance.now() - startTime,
      };

      return {
        success: true,
        output: output as unknown as Record<string, unknown>,
        durationMs: output.durationMs,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    const durationMs = performance.now() - startTime;

    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return {
          success: false,
          error: "Request timed out",
          durationMs,
        };
      }
      return {
        success: false,
        error: error.message,
        durationMs,
      };
    }

    return {
      success: false,
      error: String(error),
      durationMs,
    };
  }
};

/**
 * HTTP Request built-in plugin definition.
 */
export const httpPlugin: BuiltinPlugin = {
  id: "builtin:http",
  name: "HTTP Request",
  description: "Make HTTP requests to external APIs and services",
  actions: {
    request: {
      name: "request",
      description: "Execute an HTTP request",
      handler: executeRequest,
    },
    get: {
      name: "get",
      description: "Execute an HTTP GET request",
      handler: async (inputs, context) =>
        executeRequest({ ...inputs, method: "GET" }, context),
    },
    post: {
      name: "post",
      description: "Execute an HTTP POST request",
      handler: async (inputs, context) =>
        executeRequest({ ...inputs, method: "POST" }, context),
    },
    put: {
      name: "put",
      description: "Execute an HTTP PUT request",
      handler: async (inputs, context) =>
        executeRequest({ ...inputs, method: "PUT" }, context),
    },
    patch: {
      name: "patch",
      description: "Execute an HTTP PATCH request",
      handler: async (inputs, context) =>
        executeRequest({ ...inputs, method: "PATCH" }, context),
    },
    delete: {
      name: "delete",
      description: "Execute an HTTP DELETE request",
      handler: async (inputs, context) =>
        executeRequest({ ...inputs, method: "DELETE" }, context),
    },
  },
};
