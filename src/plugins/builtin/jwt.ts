/**
 * Built-in JWT Plugin
 *
 * Create, verify, and decode JWT tokens.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

interface JwtInput {
  operation: "create" | "verify" | "decode";
  input: string;
  secret?: string;
  algorithm?: "HS256" | "HS384" | "HS512";
  expiresIn?: number;
}

const base64UrlEncode = (str: string): string => {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const base64UrlDecode = (str: string): string => {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
};

const bufferToBase64Url = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const getHashAlgorithm = (alg: string): string => {
  switch (alg) {
    case "HS384":
      return "SHA-384";
    case "HS512":
      return "SHA-512";
    default:
      return "SHA-256";
  }
};

const jwtOperation = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      operation,
      input,
      secret,
      algorithm = "HS256",
      expiresIn,
    } = inputs as unknown as JwtInput;

    if (operation === "create") {
      if (!secret) {
        return {
          success: false,
          error: "Secret is required for creating JWT",
          durationMs: performance.now() - startTime,
        };
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(input);
      } catch {
        return {
          success: false,
          error: "Input must be valid JSON for JWT payload",
          durationMs: performance.now() - startTime,
        };
      }

      const now = Math.floor(Date.now() / 1000);
      payload.iat = now;
      if (expiresIn) {
        payload.exp = now + expiresIn;
      }

      const header = { alg: algorithm, typ: "JWT" };
      const encodedHeader = base64UrlEncode(JSON.stringify(header));
      const encodedPayload = base64UrlEncode(JSON.stringify(payload));
      const signatureInput = `${encodedHeader}.${encodedPayload}`;

      const encoder = new TextEncoder();
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: getHashAlgorithm(algorithm) },
        false,
        ["sign"],
      );

      const signature = await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        encoder.encode(signatureInput),
      );

      const token = `${signatureInput}.${bufferToBase64Url(signature)}`;

      return {
        success: true,
        output: { token, payload },
        durationMs: performance.now() - startTime,
      };
    }

    if (operation === "decode") {
      const parts = input.split(".");
      if (parts.length !== 3) {
        return {
          success: false,
          error: "Invalid JWT format",
          durationMs: performance.now() - startTime,
        };
      }

      const header = JSON.parse(base64UrlDecode(parts[0]));
      const payload = JSON.parse(base64UrlDecode(parts[1]));

      return {
        success: true,
        output: { header, payload, valid: null },
        durationMs: performance.now() - startTime,
      };
    }

    if (operation === "verify") {
      if (!secret) {
        return {
          success: false,
          error: "Secret is required for verifying JWT",
          durationMs: performance.now() - startTime,
        };
      }

      const parts = input.split(".");
      if (parts.length !== 3) {
        return {
          success: false,
          error: "Invalid JWT format",
          durationMs: performance.now() - startTime,
        };
      }

      const signatureInput = `${parts[0]}.${parts[1]}`;
      const header = JSON.parse(base64UrlDecode(parts[0]));
      const payload = JSON.parse(base64UrlDecode(parts[1]));

      const encoder = new TextEncoder();
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: getHashAlgorithm(header.alg || algorithm) },
        false,
        ["verify"],
      );

      let providedSig = parts[2].replace(/-/g, "+").replace(/_/g, "/");
      while (providedSig.length % 4) providedSig += "=";
      const sigBytes = Uint8Array.from(atob(providedSig), (c) =>
        c.charCodeAt(0),
      );

      const valid = await crypto.subtle.verify(
        "HMAC",
        cryptoKey,
        sigBytes,
        encoder.encode(signatureInput),
      );

      const now = Math.floor(Date.now() / 1000);
      const expired = payload.exp ? now > payload.exp : false;

      return {
        success: true,
        output: {
          valid: valid && !expired,
          expired,
          header,
          payload,
        },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: false,
      error: `Unknown operation: ${operation}`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

export const jwtPlugin: BuiltinPlugin = {
  id: "builtin:jwt",
  name: "JWT",
  description: "Create, verify, and decode JWT tokens",
  actions: {
    token: {
      name: "token",
      description: "JWT token operations",
      handler: jwtOperation,
    },
  },
};
