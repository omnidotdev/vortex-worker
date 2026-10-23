import { describe, expect, it } from "bun:test";

import {
  GATEWAY_UPSTREAM_TIMEOUT_MS,
  S3_CONNECTION_TIMEOUT_MS,
  S3_REQUEST_TIMEOUT_MS,
  createResilientS3Client,
  s3RequestHandlerOptions,
} from "../s3Client";

/**
 * Regression coverage for the latent S3 keep-alive socket hang.
 *
 * Root cause: the SDK default request handler pools keep-alive sockets and
 * sets no throwing request timeout. Sockets to an S3 endpoint behind a NAT/edge
 * that idle-drops connections without a RST go zombie; every reuse then blocks
 * ~30s until an upstream gateway gives up.
 *
 * These tests fail if either load-bearing setting regresses: keep-alive being
 * re-enabled (which reintroduces reused-zombie hangs) or the request timeout
 * losing `throwOnRequestTimeout` (on @smithy/node-http-handler v4 a plain
 * request timeout only warns and keeps hanging).
 */

describe("createResilientS3Client config", () => {
  it("disables keep-alive and configures a throwing connection + request timeout", async () => {
    const client = createResilientS3Client({
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });

    // `configProvider` resolves eagerly and without any network call, unlike
    // `httpHandlerConfigs()` which is empty until the first request
    const handler = client.config.requestHandler as unknown as {
      configProvider: Promise<{
        connectionTimeout?: number;
        requestTimeout?: number;
        throwOnRequestTimeout?: boolean;
        httpsAgent?: { keepAlive?: boolean; options?: { keepAlive?: boolean } };
      }>;
    };
    const resolved = await handler.configProvider;

    expect(resolved.connectionTimeout).toBe(S3_CONNECTION_TIMEOUT_MS);
    expect(resolved.requestTimeout).toBe(S3_REQUEST_TIMEOUT_MS);
    // The flag that makes the timeout actually abort instead of only warning
    expect(resolved.throwOnRequestTimeout).toBe(true);
    // Never reuse a socket, so a dropped connection cannot become a zombie
    const keepAlive =
      resolved.httpsAgent?.keepAlive ?? resolved.httpsAgent?.options?.keepAlive;
    expect(keepAlive).toBe(false);
  });

  it("keeps the request timeout below the gateway upstream timeout so a stuck request self-heals before the gateway times out", () => {
    expect(S3_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(S3_REQUEST_TIMEOUT_MS).toBeLessThan(GATEWAY_UPSTREAM_TIMEOUT_MS);
    expect(S3_CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("threads timeout overrides into the handler options and always throws on timeout", () => {
    expect(
      s3RequestHandlerOptions({
        connectionTimeoutMs: 100,
        requestTimeoutMs: 250,
      }),
    ).toEqual({
      connectionTimeout: 100,
      requestTimeout: 250,
      throwOnRequestTimeout: true,
    });
  });
});
