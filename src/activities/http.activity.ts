import { assertSafeResolvedUrl } from "lib/ssrf";

/** Maximum number of redirect hops to follow, each re-validated for SSRF */
const MAX_REDIRECTS = 5;

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

  // Validate URL format before attempting fetch
  if (!input.url || typeof input.url !== "string" || !input.url.trim()) {
    throw new Error("URL is required (received empty or missing value)");
  }

  try {
    new URL(input.url);
  } catch {
    throw new Error(
      `Invalid URL: "${input.url}". Ensure the URL includes a scheme (https://) and is a valid address`,
    );
  }

  // SSRF protection: validate the RESOLVED address (DNS) before requesting
  await assertSafeResolvedUrl(input.url);

  try {
    // Follow redirects manually so every hop is re-validated for SSRF
    let currentUrl = input.url;
    let redirectsLeft = MAX_REDIRECTS;
    let response = await fetch(currentUrl, {
      method: input.method,
      headers: input.headers,
      body: input.body,
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
      await assertSafeResolvedUrl(nextUrl);
      currentUrl = nextUrl;
      redirectsLeft -= 1;
      response = await fetch(currentUrl, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        signal: controller.signal,
        redirect: "manual",
      });
    }

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
