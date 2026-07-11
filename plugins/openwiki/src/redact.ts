import { OpenWikiError } from "./errors.js";

export const REDACTED_VALUE = "[REDACTED]";

const SENSITIVE_KEY_PATTERN =
  /(?:^|[_-])(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|secret|token)(?:$|[_-])/iu;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu;
const AUTHORIZATION_PATTERN =
  /\b(?:proxy-)?authorization\s*[:=]\s*(?:bearer|basic)?\s*[A-Za-z0-9._~+/=-]{8,}/giu;
const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const NAMED_SECRET_PATTERN =
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/giu;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/giu;
const OPENAI_TOKEN_PATTERN = /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/gu;
const GITHUB_TOKEN_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const URL_CREDENTIAL_PATTERN =
  /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu;

export function redactSensitive(value: unknown): unknown {
  return redactValue(value, new WeakSet());
}

export function containsSensitive(value: unknown): boolean {
  return inspectValue(value, new WeakSet());
}

function redactValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return withObjectGuard(value, ancestors, () =>
      value.map((item) => redactValue(item, ancestors)),
    );
  }
  if (isPlainRecord(value)) {
    return withObjectGuard(value, ancestors, () => redactRecord(value, ancestors));
  }

  throw new OpenWikiError(
    "INVALID_ARGUMENT",
    "Sensitive data redaction requires a JSON-compatible value.",
  );
}

function redactRecord(
  record: Record<string, unknown>,
  ancestors: WeakSet<object>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};

  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = rawKey.replaceAll("\0", "");
    if (Object.hasOwn(redacted, key)) {
      throw new OpenWikiError(
        "INVALID_ARGUMENT",
        "Sensitive data redaction produced duplicate object keys.",
      );
    }
    redacted[key] = isSensitiveKey(key)
      ? REDACTED_VALUE
      : redactValue(rawValue, ancestors);
  }

  return redacted;
}

function inspectValue(value: unknown, ancestors: WeakSet<object>): boolean {
  if (typeof value === "string") {
    return redactString(value) !== value.replaceAll("\0", "");
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return false;
  }
  if (Array.isArray(value)) {
    return withObjectGuard(value, ancestors, () =>
      value.some((item) => inspectValue(item, ancestors)),
    );
  }
  if (isPlainRecord(value)) {
    return withObjectGuard(value, ancestors, () => {
      for (const [key, child] of Object.entries(value)) {
        if (isSensitiveKey(key)) {
          if (child !== REDACTED_VALUE) {
            return true;
          }
          continue;
        }
        if (inspectValue(child, ancestors)) {
          return true;
        }
      }
      return false;
    });
  }
  return false;
}

function redactString(value: string): string {
  return value
    .replaceAll("\0", "")
    .replace(PRIVATE_KEY_PATTERN, REDACTED_VALUE)
    .replace(AUTHORIZATION_PATTERN, `authorization: ${REDACTED_VALUE}`)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED_VALUE}`)
    .replace(NAMED_SECRET_PATTERN, REDACTED_VALUE)
    .replace(SLACK_TOKEN_PATTERN, REDACTED_VALUE)
    .replace(OPENAI_TOKEN_PATTERN, REDACTED_VALUE)
    .replace(GITHUB_TOKEN_PATTERN, REDACTED_VALUE)
    .replace(JWT_PATTERN, REDACTED_VALUE)
    .replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED_VALUE}@`);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase();
  return SENSITIVE_KEY_PATTERN.test(`_${normalized}_`);
}

function withObjectGuard<T>(
  value: object,
  ancestors: WeakSet<object>,
  operation: () => T,
): T {
  if (ancestors.has(value)) {
    throw new OpenWikiError(
      "INVALID_ARGUMENT",
      "Sensitive data redaction does not accept cyclic values.",
    );
  }
  ancestors.add(value);
  try {
    return operation();
  } finally {
    ancestors.delete(value);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
