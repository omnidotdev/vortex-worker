/**
 * Sensitive data redaction utility.
 * Masks sensitive values before storing in the database.
 */

const SENSITIVE_FIELD_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /apikey/i,
  /api_key/i,
  /api-key/i,
  /^apiKey$/,
  /authorization/i,
  /credential/i,
  /private/i,
  /^key$/i,
  /accesskey/i,
  /access_key/i,
  /secretkey/i,
  /secret_key/i,
  /^accessToken$/,
  /^access_token$/,
  /^refreshToken$/,
  /^refresh_token$/,
  /bearer/i,
  /cookie/i,
  /session/i,
  /auth/i,
];

const SENSITIVE_VALUE_PATTERNS = [
  // Bearer tokens
  /^Bearer\s+.+$/i,
  // API keys with common prefixes
  /^sk[-_].+/i, // OpenAI, Stripe
  /^pk[-_].+/i, // Stripe public keys
  /^xoxb-.+/i, // Slack bot tokens
  /^xoxp-.+/i, // Slack user tokens
  /^ghp_.+/i, // GitHub personal access tokens
  /^gho_.+/i, // GitHub OAuth tokens
  /^ghu_.+/i, // GitHub user-to-server tokens
  /^ghs_.+/i, // GitHub server-to-server tokens
  /^ghr_.+/i, // GitHub refresh tokens
  /^glpat-.+/i, // GitLab personal access tokens
  /^AKIA.+/i, // AWS access keys
  /^eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/i, // JWTs
  /^whsec_.+/i, // Webhook signing secrets
  /^rk_.+/i, // Resend keys
  /^SG\..+/i, // SendGrid API keys
  /^AIza.+/i, // Google API keys
];

const REDACTED = "[REDACTED]";

/**
 * Check if a field name is sensitive.
 */
function isSensitiveField(fieldName: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(fieldName));
}

/**
 * Check if a value looks like a sensitive token/key.
 */
function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Recursively redact sensitive data from an object.
 * Returns a deep clone with sensitive values replaced with "[REDACTED]".
 */
/**
 * Recursively redact sensitive data from an object.
 * Returns a deep clone with sensitive values replaced with "[REDACTED]".
 */
export function redactSensitive(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "string") {
    return isSensitiveValue(obj) ? REDACTED : obj;
  }

  if (typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitive(item));
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveField(key)) {
      result[key] = REDACTED;
    } else if (typeof value === "string" && isSensitiveValue(value)) {
      result[key] = REDACTED;
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactSensitive(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}
