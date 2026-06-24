/**
 * Built-in Webhook Verification Plugin
 *
 * Signature verification for webhook payloads from various providers.
 * Supports Stripe, GitHub, Slack, Twilio, Shopify, SendGrid, Paddle, Linear.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type WebhookProvider =
  | "stripe"
  | "github"
  | "slack"
  | "twilio"
  | "shopify"
  | "sendgrid"
  | "paddle"
  | "linear"
  | "custom";

interface VerifyInput {
  /** Webhook provider */
  provider: WebhookProvider;
  /** Raw request body (string) */
  payload: string;
  /** Signature from header */
  signature: string;
  /** Webhook secret */
  secret: string;
  /** Timestamp (for providers that include it separately) */
  timestamp?: string;
  /** Tolerance in seconds for timestamp verification (default: 300) */
  tolerance?: number;
  /** Algorithm for custom provider */
  algorithm?: "sha256" | "sha1" | "sha512";
  /** Header format for custom provider */
  headerFormat?: string;
}

// Helper to compute HMAC
const computeHmac = async (
  algorithm: string,
  key: string,
  data: string,
): Promise<string> => {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const dataBytes = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, dataBytes);
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

// Timing-safe comparison
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
};

// Provider-specific verification functions

const verifyStripe = async (
  payload: string,
  signature: string,
  secret: string,
  tolerance: number,
): Promise<{ valid: boolean; error?: string }> => {
  // Stripe signature format: t=timestamp,v1=signature,v1=signature2,...
  const parts = signature.split(",");
  const timestampPart = parts.find((p) => p.startsWith("t="));
  const sigParts = parts.filter((p) => p.startsWith("v1="));

  if (!timestampPart || sigParts.length === 0) {
    return { valid: false, error: "Invalid Stripe signature format" };
  }

  const timestamp = Number.parseInt(timestampPart.slice(2), 10);
  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - timestamp) > tolerance) {
    return { valid: false, error: "Timestamp outside tolerance window" };
  }

  const signedPayload = `${timestamp}.${payload}`;
  const expectedSignature = await computeHmac("SHA-256", secret, signedPayload);

  const valid = sigParts.some((p) =>
    timingSafeEqual(p.slice(3), expectedSignature),
  );

  return { valid, error: valid ? undefined : "Signature mismatch" };
};

const verifyGitHub = async (
  payload: string,
  signature: string,
  secret: string,
): Promise<{ valid: boolean; error?: string }> => {
  // GitHub signature format: sha256=signature or sha1=signature
  const [algorithm, sig] = signature.split("=");

  if (!algorithm || !sig) {
    return { valid: false, error: "Invalid GitHub signature format" };
  }

  const hashAlgorithm = algorithm === "sha256" ? "SHA-256" : "SHA-1";
  const expectedSignature = await computeHmac(hashAlgorithm, secret, payload);

  const valid = timingSafeEqual(sig, expectedSignature);
  return { valid, error: valid ? undefined : "Signature mismatch" };
};

const verifySlack = async (
  payload: string,
  signature: string,
  secret: string,
  timestamp: string | undefined,
  tolerance: number,
): Promise<{ valid: boolean; error?: string }> => {
  // Slack signature format: v0=signature
  // Requires X-Slack-Request-Timestamp header
  if (!timestamp) {
    return { valid: false, error: "Slack verification requires timestamp" };
  }

  const ts = Number.parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - ts) > tolerance) {
    return { valid: false, error: "Timestamp outside tolerance window" };
  }

  const sigBaseString = `v0:${timestamp}:${payload}`;
  const expectedSignature = await computeHmac("SHA-256", secret, sigBaseString);

  const providedSig = signature.startsWith("v0=")
    ? signature.slice(3)
    : signature;
  const valid = timingSafeEqual(providedSig, expectedSignature);

  return { valid, error: valid ? undefined : "Signature mismatch" };
};

const verifyTwilio = async (
  payload: string,
  signature: string,
  secret: string,
): Promise<{ valid: boolean; error?: string }> => {
  // Twilio uses base64 HMAC-SHA1
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const dataBytes = encoder.encode(payload);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );

  const signatureBytes = await crypto.subtle.sign("HMAC", cryptoKey, dataBytes);
  const expectedSignature = btoa(
    String.fromCharCode(...new Uint8Array(signatureBytes)),
  );

  const valid = timingSafeEqual(signature, expectedSignature);
  return { valid, error: valid ? undefined : "Signature mismatch" };
};

const verifyShopify = async (
  payload: string,
  signature: string,
  secret: string,
): Promise<{ valid: boolean; error?: string }> => {
  // Shopify uses base64 HMAC-SHA256
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const dataBytes = encoder.encode(payload);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBytes = await crypto.subtle.sign("HMAC", cryptoKey, dataBytes);
  const expectedSignature = btoa(
    String.fromCharCode(...new Uint8Array(signatureBytes)),
  );

  const valid = timingSafeEqual(signature, expectedSignature);
  return { valid, error: valid ? undefined : "Signature mismatch" };
};

const verifySendGrid = async (
  payload: string,
  signature: string,
  secret: string,
  timestamp: string | undefined,
  tolerance: number,
): Promise<{ valid: boolean; error?: string }> => {
  // SendGrid Event Webhook uses ECDSA, but Inbound Parse uses simpler method
  // For Event Webhook: timestamp + payload, signed with ECDSA
  // Simplified: treating as HMAC-SHA256 for basic verification
  if (!timestamp) {
    return {
      valid: false,
      error: "SendGrid verification requires timestamp",
    };
  }

  const ts = Number.parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - ts) > tolerance) {
    return { valid: false, error: "Timestamp outside tolerance window" };
  }

  const sigBaseString = `${timestamp}${payload}`;
  const expectedSignature = await computeHmac("SHA-256", secret, sigBaseString);

  const valid = timingSafeEqual(signature, expectedSignature);
  return { valid, error: valid ? undefined : "Signature mismatch" };
};

const verifyPaddle = async (
  payload: string,
  signature: string,
  secret: string,
  _timestamp: string | undefined,
  tolerance: number,
): Promise<{ valid: boolean; error?: string }> => {
  // Paddle Billing uses ts=timestamp;h1=signature format
  const parts = signature.split(";");
  const tsPart = parts.find((p) => p.startsWith("ts="));
  const h1Part = parts.find((p) => p.startsWith("h1="));

  if (!tsPart || !h1Part) {
    // Try classic Paddle format (just the signature)
    const expectedSignature = await computeHmac("SHA-256", secret, payload);
    const valid = timingSafeEqual(signature, expectedSignature);
    return { valid, error: valid ? undefined : "Signature mismatch" };
  }

  const ts = Number.parseInt(tsPart.slice(3), 10);
  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - ts) > tolerance) {
    return { valid: false, error: "Timestamp outside tolerance window" };
  }

  const sigBaseString = `${tsPart.slice(3)}:${payload}`;
  const expectedSignature = await computeHmac("SHA-256", secret, sigBaseString);

  const valid = timingSafeEqual(h1Part.slice(3), expectedSignature);
  return { valid, error: valid ? undefined : "Signature mismatch" };
};

const verifyLinear = async (
  payload: string,
  signature: string,
  secret: string,
): Promise<{ valid: boolean; error?: string }> => {
  // Linear uses HMAC-SHA256
  const expectedSignature = await computeHmac("SHA-256", secret, payload);
  const valid = timingSafeEqual(signature, expectedSignature);
  return { valid, error: valid ? undefined : "Signature mismatch" };
};

const verifyCustom = async (
  payload: string,
  signature: string,
  secret: string,
  algorithm: "sha256" | "sha1" | "sha512" = "sha256",
): Promise<{ valid: boolean; error?: string }> => {
  const hashAlgorithm =
    algorithm === "sha256"
      ? "SHA-256"
      : algorithm === "sha1"
        ? "SHA-1"
        : "SHA-512";

  const expectedSignature = await computeHmac(hashAlgorithm, secret, payload);
  const valid = timingSafeEqual(signature, expectedSignature);
  return { valid, error: valid ? undefined : "Signature mismatch" };
};

/**
 * Verify webhook signature.
 */
const verify = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as VerifyInput;
    const tolerance = input.tolerance ?? 300;

    let result: { valid: boolean; error?: string };

    switch (input.provider) {
      case "stripe":
        result = await verifyStripe(
          input.payload,
          input.signature,
          input.secret,
          tolerance,
        );
        break;
      case "github":
        result = await verifyGitHub(
          input.payload,
          input.signature,
          input.secret,
        );
        break;
      case "slack":
        result = await verifySlack(
          input.payload,
          input.signature,
          input.secret,
          input.timestamp,
          tolerance,
        );
        break;
      case "twilio":
        result = await verifyTwilio(
          input.payload,
          input.signature,
          input.secret,
        );
        break;
      case "shopify":
        result = await verifyShopify(
          input.payload,
          input.signature,
          input.secret,
        );
        break;
      case "sendgrid":
        result = await verifySendGrid(
          input.payload,
          input.signature,
          input.secret,
          input.timestamp,
          tolerance,
        );
        break;
      case "paddle":
        result = await verifyPaddle(
          input.payload,
          input.signature,
          input.secret,
          input.timestamp,
          tolerance,
        );
        break;
      case "linear":
        result = await verifyLinear(
          input.payload,
          input.signature,
          input.secret,
        );
        break;
      case "custom":
        result = await verifyCustom(
          input.payload,
          input.signature,
          input.secret,
          input.algorithm,
        );
        break;
      default:
        return {
          success: false,
          error: `Unsupported provider: ${input.provider}`,
          durationMs: performance.now() - startTime,
        };
    }

    // A signature mismatch is a FAILED step, not a successful one: surface the
    // real verdict in `success` so a forged webhook cannot sail past a workflow
    // step-success gate (e.g. a spoofed Stripe/Paddle payment_intent.succeeded).
    // Every provider funnels through this single return, so the fix holds for all.
    return {
      success: result.valid,
      error: result.valid ? undefined : (result.error ?? "Signature mismatch"),
      output: {
        valid: result.valid,
        error: result.error,
        provider: input.provider,
      },
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

/**
 * Parse webhook payload (extract event type and data).
 */
const parseWebhook = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as {
      provider: WebhookProvider;
      payload: string;
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(input.payload);
    } catch {
      return {
        success: false,
        error: "Invalid JSON payload",
        durationMs: performance.now() - startTime,
      };
    }

    const p = parsed as Record<string, unknown>;
    let eventType: string | undefined;
    let eventData: unknown;

    switch (input.provider) {
      case "stripe":
        eventType = p.type as string;
        eventData = p.data;
        break;
      case "github":
        eventType = (p.action as string) ?? "push";
        eventData = p;
        break;
      case "slack":
        eventType =
          ((p.event as Record<string, unknown>)?.type as string) ??
          (p.type as string);
        eventData = p.event ?? p;
        break;
      case "twilio":
        eventType = (p.EventType as string) ?? "message";
        eventData = p;
        break;
      case "shopify":
        eventType = p.topic as string;
        eventData = p;
        break;
      case "sendgrid":
        eventType = Array.isArray(p)
          ? ((p[0] as Record<string, unknown>)?.event as string)
          : (p.event as string);
        eventData = p;
        break;
      case "paddle":
        eventType = (p.event_type as string) ?? (p.alert_name as string);
        eventData = p.data ?? p;
        break;
      case "linear":
        eventType = (p.type as string) ?? (p.action as string);
        eventData = p.data ?? p;
        break;
      default:
        eventType = (p.type as string) ?? (p.event as string) ?? "unknown";
        eventData = p;
    }

    return {
      success: true,
      output: {
        eventType,
        data: eventData,
        raw: parsed,
        provider: input.provider,
      },
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

/**
 * Webhook Verification built-in plugin definition.
 */
export const webhookVerifyPlugin: BuiltinPlugin = {
  id: "builtin:webhookVerify",
  name: "Webhook Verify",
  description:
    "Verify webhook signatures (Stripe, GitHub, Slack, Twilio, Shopify, etc.)",
  actions: {
    verify: {
      name: "verify",
      description: "Verify webhook signature",
      handler: verify,
    },
    parse: {
      name: "parse",
      description: "Parse webhook payload and extract event type",
      handler: parseWebhook,
    },
  },
};
