import { describe, expect, test } from "bun:test";

import {
  DEFAULT_WARN_WINDOW_MS,
  decodeJwtExpiryMs,
  inspectHatchetToken,
} from "lib/hatchetToken";

/** Build a JWT with the given payload. The signature is irrelevant to decoding. */
function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64url({ alg: "ES256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

const NOW = 1_700_000_000_000; // fixed reference time in ms

describe("decodeJwtExpiryMs", () => {
  test("decodes exp (seconds) to epoch milliseconds", () => {
    const token = makeJwt({ exp: 1_700_000_500, sub: "tenant" });
    expect(decodeJwtExpiryMs(token)).toBe(1_700_000_500_000);
  });

  test("returns null when not a three-part JWT", () => {
    expect(decodeJwtExpiryMs("not-a-jwt")).toBeNull();
    expect(decodeJwtExpiryMs("only.two")).toBeNull();
  });

  test("returns null when payload has no numeric exp", () => {
    expect(decodeJwtExpiryMs(makeJwt({ sub: "tenant" }))).toBeNull();
    expect(decodeJwtExpiryMs(makeJwt({ exp: "soon" }))).toBeNull();
  });

  test("returns null when payload is not valid base64 JSON", () => {
    expect(decodeJwtExpiryMs("header.@@@notbase64@@@.sig")).toBeNull();
  });
});

describe("inspectHatchetToken", () => {
  test("reports ok when expiry is comfortably in the future", () => {
    const token = makeJwt({ exp: (NOW + 90 * 24 * 3600 * 1000) / 1000 });
    expect(inspectHatchetToken(token, NOW)).toEqual({
      status: "ok",
      expiresAtMs: NOW + 90 * 24 * 3600 * 1000,
    });
  });

  test("reports expiring when within the warn window", () => {
    const expiresAtMs = NOW + DEFAULT_WARN_WINDOW_MS - 1000;
    const token = makeJwt({ exp: expiresAtMs / 1000 });
    expect(inspectHatchetToken(token, NOW)).toEqual({
      status: "expiring",
      expiresAtMs,
    });
  });

  test("reports expired once exp is at or before now", () => {
    const expiresAtMs = NOW - 1000;
    const token = makeJwt({ exp: expiresAtMs / 1000 });
    expect(inspectHatchetToken(token, NOW).status).toBe("expired");
  });

  test("treats exactly-now as expired (boundary)", () => {
    const token = makeJwt({ exp: NOW / 1000 });
    expect(inspectHatchetToken(token, NOW).status).toBe("expired");
  });

  test("reports unparseable for a non-JWT token", () => {
    expect(inspectHatchetToken("garbage", NOW)).toEqual({
      status: "unparseable",
      expiresAtMs: null,
    });
  });

  test("honors a custom warn window", () => {
    const expiresAtMs = NOW + 3 * 24 * 3600 * 1000; // 3 days out
    const token = makeJwt({ exp: expiresAtMs / 1000 });
    // 1-day window: still ok
    expect(inspectHatchetToken(token, NOW, 24 * 3600 * 1000).status).toBe("ok");
    // 7-day window: expiring
    expect(inspectHatchetToken(token, NOW, 7 * 24 * 3600 * 1000).status).toBe(
      "expiring",
    );
  });
});
