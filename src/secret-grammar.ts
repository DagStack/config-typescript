// Internal parser for `${secret:<scheme>:<path>[?query][#field][:-default]}`.
//
// Implements the grammar from ADR-0002 v1.1 §1 + `_meta/secret_ref_grammar.yaml`.
// The single public entry point is `parseSecretRef` — given the inner
// content of one `${secret:...}` token (the bytes between `${secret:`
// and `}`), it returns a `SecretRef` placeholder.
//
// The outer-token regex (`SECRET_REF_OUTER`) is exposed for the YAML
// interpolator: a YAML string with multiple references is scanned with
// this pattern, and each match's group(1) is fed to `parseSecretRef`.
//
// Escape rules per ADR-0002 v1.1 §1:
// - `##` → literal `#` inside path
// - `??` → literal `?` inside path
// - `::-` → literal `:-` inside path
// - query_value uses RFC 3986 percent-encoding (decodeURIComponent)
//
// This module is internal — application code uses the resulting
// `SecretRef` indirectly through `Config.getString` etc.

import { ConfigError, ConfigErrorReason } from "./errors.js";
import { isSecretRef, makeSecretRef, type SecretRef } from "./secrets.js";

/**
 * Outer envelope: matches the WHOLE token shell. Group 1 is the inner
 * content. Pattern matches `_meta/secret_ref_grammar.yaml` field
 * `regex_outer.typescript` byte-for-byte.
 */
export const SECRET_REF_OUTER = /\$\{secret:([^}]*)\}/g;

const SCHEME_RE = /^[a-z][a-z0-9_]*$/;

// Control-byte sentinels for the two-pass path-unescape. Using control
// bytes ensures we never collide with characters legitimately present
// in the path or query (Vault paths and env-var names are conventionally
// printable ASCII; if a future backend needs raw control bytes, the
// query-value percent-encoding rule covers them).
const SENTINEL_QUERY = String.fromCharCode(0x00);
const SENTINEL_HASH = String.fromCharCode(0x01);
const SENTINEL_COLONDASH = String.fromCharCode(0x02);

/**
 * Parse the inner content of one `${secret:...}` token.
 *
 * `inner` is the string between `${secret:` and `}` (no braces).
 * Example: `vault:secret/dagstack/prod/db?version=3#password:-fallback`.
 * `originSource` is the diagnostic id of the source that emitted the
 * token (typically a `ConfigSource.id`).
 */
export function parseSecretRef(inner: string, originSource = ""): SecretRef {
  // Step 1 — split off the optional `:-default` tail. Honour the
  // `::-` escape: literal `:-` inside path is written as `::-`.
  const [pathWithQueryField, defaultValue] = splitDefault(inner);

  // Step 2 — split scheme from the rest. The first ":" terminates
  // scheme; ":" inside path is allowed and escape-free.
  const schemeEnd = pathWithQueryField.indexOf(":");
  if (schemeEnd < 0) {
    throw new ConfigError({
      path: "",
      reason: ConfigErrorReason.PARSE_ERROR,
      details: `secret reference missing ':' between scheme and path: '\${secret:${inner}}'`,
    });
  }
  const scheme = pathWithQueryField.slice(0, schemeEnd);
  const pathPart = pathWithQueryField.slice(schemeEnd + 1);

  // Step 3 — validate scheme grammar.
  if (!SCHEME_RE.test(scheme)) {
    throw new ConfigError({
      path: "",
      reason: ConfigErrorReason.PARSE_ERROR,
      details:
        `secret reference scheme '${scheme}' does not match ` +
        `[a-z][a-z0-9_]*: '\${secret:${inner}}'`,
    });
  }

  // Step 4 — split off the optional `#field` projection. Honour `##`.
  const [pathWithQuery, fieldProj] = splitField(pathPart);

  // Step 5 — split off the optional `?query`. Honour `??`.
  const [pathOnly, query] = splitQuery(pathWithQuery);

  // Step 6 — unescape the path: `??` → `?`, `##` → `#`, `::-` → `:-`.
  let pathUnescaped = pathOnly
    .replaceAll("??", SENTINEL_QUERY)
    .replaceAll("##", SENTINEL_HASH)
    .replaceAll("::-", SENTINEL_COLONDASH);
  if (pathUnescaped.includes("?") || pathUnescaped.includes("#")) {
    const bad = pathUnescaped.includes("?") ? "?" : "#";
    throw new ConfigError({
      path: "",
      reason: ConfigErrorReason.PARSE_ERROR,
      details:
        `unescaped '${bad}' in secret reference path ` +
        `(use '${bad}${bad}' for a literal '${bad}'): '\${secret:${inner}}'`,
    });
  }
  pathUnescaped = pathUnescaped
    .replaceAll(SENTINEL_QUERY, "?")
    .replaceAll(SENTINEL_HASH, "#")
    .replaceAll(SENTINEL_COLONDASH, ":-");

  // Compose the canonical full path: <unescaped-path>[?query][#field].
  let fullPath = pathUnescaped;
  if (query !== undefined) {
    fullPath += "?" + decodeQuery(query);
  }
  if (fieldProj !== undefined) {
    fullPath += "#" + fieldProj.replace(/##/g, "#");
  }

  return makeSecretRef({
    scheme,
    path: fullPath,
    default: defaultValue,
    originSource,
  });
}

function splitDefault(s: string): [string, string | undefined] {
  // Walk the string finding the first unescaped ":-" boundary.
  let i = 0;
  const n = s.length;
  while (i < n - 1) {
    if (s[i] === ":" && s[i + 1] === "-") {
      // ":-" preceded by ":" → "::-" escape, consume past.
      if (i > 0 && s[i - 1] === ":") {
        i += 2;
        continue;
      }
      return [s.slice(0, i), s.slice(i + 2)];
    }
    i += 1;
  }
  return [s, undefined];
}

function splitField(s: string): [string, string | undefined] {
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] === "#") {
      if (i + 1 < n && s[i + 1] === "#") {
        // "##" escape — consume past.
        i += 2;
        continue;
      }
      return [s.slice(0, i), s.slice(i + 1)];
    }
    i += 1;
  }
  return [s, undefined];
}

function splitQuery(s: string): [string, string | undefined] {
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] === "?") {
      if (i + 1 < n && s[i + 1] === "?") {
        // "??" escape — consume past.
        i += 2;
        continue;
      }
      return [s.slice(0, i), s.slice(i + 1)];
    }
    i += 1;
  }
  return [s, undefined];
}

function decodeQuery(query: string): string {
  return query
    .split("&")
    .map((kv) => {
      if (!kv.includes("=")) {
        throw new ConfigError({
          path: "",
          reason: ConfigErrorReason.PARSE_ERROR,
          details:
            `secret reference query parameter '${kv}' is missing '=' ` +
            "(grammar: query_kv := query_key '=' query_value)",
        });
      }
      const eqIndex = kv.indexOf("=");
      const key = kv.slice(0, eqIndex);
      const value = kv.slice(eqIndex + 1);
      return `${key}=${decodeURIComponent(value)}`;
    })
    .join("&");
}

/**
 * Walk a freshly-loaded tree, converting `${secret:...}` strings to
 * `SecretRef` placeholders.
 *
 * Called by each ConfigSource immediately after YAML/JSON parse. The
 * Phase 1 raw-text interpolator already left `${secret:...}` tokens
 * intact (`interpolation.ts` re-emits them verbatim), so this walker
 * sees them as plain strings in scalar leaves.
 *
 * Behaviour:
 * - String leaf containing exactly one `${secret:...}` token and
 *   nothing else → replaced with a `SecretRef`.
 * - String leaf containing the token alongside other text → throws
 *   `ConfigError(PARSE_ERROR)` (splicing a secret into surrounding
 *   text is ambiguous and not supported in Phase 2 — composes secrets
 *   at the application level instead).
 * - String leaf with no token → unchanged.
 * - Mappings and arrays → recursed.
 */
export function walkSecretRefs(tree: unknown, sourceId: string): unknown {
  if (Array.isArray(tree)) {
    return tree.map((v) => walkSecretRefs(v, sourceId));
  }
  if (tree !== null && typeof tree === "object" && !isSecretRef(tree)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tree)) {
      out[k] = walkSecretRefs(v, sourceId);
    }
    return out;
  }
  if (typeof tree === "string") {
    return convertString(tree, sourceId);
  }
  return tree;
}

function convertString(s: string, sourceId: string): unknown {
  // Reset regex lastIndex (global flag).
  SECRET_REF_OUTER.lastIndex = 0;
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = SECRET_REF_OUTER.exec(s)) !== null) {
    matches.push(m);
  }
  if (matches.length === 0) {
    return s;
  }
  if (matches.length === 1 && matches[0] !== undefined) {
    const only = matches[0];
    if (only.index === 0 && only.index + only[0].length === s.length) {
      return parseSecretRef(only[1] ?? "", sourceId);
    }
  }
  throw new ConfigError({
    path: "",
    reason: ConfigErrorReason.PARSE_ERROR,
    details:
      "a ${secret:...} reference must occupy the whole scalar value; " +
      "mixing it with other text is not supported (compose secrets at the " +
      `application level instead): ${JSON.stringify(s)}`,
    sourceId,
  });
}
