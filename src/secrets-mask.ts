// Secret field masking per ADR-0001 v2.2 §6 / `_meta/secret_patterns.yaml`.
// When the spec is updated, keep the constants below in sync.

export const MASKED_PLACEHOLDER = "[MASKED]";

const SECRET_SUFFIXES: readonly string[] = [
  "_key",
  "_secret",
  "_token",
  "_password",
  "_passphrase",
  "_credentials",
  "_credential",
  "_auth",
  "_api_key",
  "_access_key",
  "_private_key",
];

const SECRET_PREFIXES: readonly string[] = [
  "api_key",
  "api_token",
  "secret",
  "password",
  "private_key",
  "access_token",
  "bearer",
];

const SECRET_EXACT: ReadonlySet<string> = new Set([
  "api_key",
  "apikey",
  "password",
  "passwd",
  "pw",
  "token",
  "secret",
  "credentials",
]);

/**
 * True if the field name matches the secret patterns.
 * Order: exact → suffix → prefix (OR semantics). Case-insensitive.
 */
export function isSecretField(name: string): boolean {
  const lowered = name.toLowerCase();
  if (SECRET_EXACT.has(lowered)) return true;
  for (const suffix of SECRET_SUFFIXES) {
    if (lowered.endsWith(suffix)) return true;
  }
  for (const prefix of SECRET_PREFIXES) {
    if (lowered.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Returns `MASKED_PLACEHOLDER` if `name` is a secret field and `value` is not
 * empty. Empty / null / undefined values pass through unchanged.
 */
export function maskValue(name: string, value: unknown): unknown {
  if (!isSecretField(name)) return value;
  if (value === null || value === undefined || value === "") return value;
  return MASKED_PLACEHOLDER;
}
