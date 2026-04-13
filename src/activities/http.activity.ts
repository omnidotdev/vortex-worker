import { assertSafeUrl } from "lib/ssrf";

export interface HttpActivityInput {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

export interface HttpActivityOutput {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
}

export async function executeHttpActivity(
  input: HttpActivityInput,
): Promise<HttpActivityOutput> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    input.timeout ?? 30000,
  );

  // SSRF protection: validate URL before making request
  assertSafeUrl(input.url);

  try {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      signal: controller.signal,
    });

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    let body: unknown;
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
