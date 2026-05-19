// Canonical JSON serializer (RFC 8785 subset).
//
// The source of truth is spec/_meta/canonical_json.yaml. Bit-identical output
// across bindings is verified through spec/conformance/expected/*.json and the
// cross-binding key-order fixture spec/conformance/canonical_json/
// key_order_drift_witness.json (5 cases).
//
// Deviations from full RFC 8785 (`deviations_from_rfc_8785:`):
//   - UTF-8 encoding is mandatory.
//   - No trailing newline.
//   - Integer safe range is ±(2^53 - 1) = Number.MAX_SAFE_INTEGER.
//   - Duplicate YAML keys are rejected (at the parser level, not the serializer).
//
// JSON.stringify already produces the shortest round-trip for floats (per
// ECMA-262), handles `\uXXXX` for control chars < 0x20, and leaves Unicode
// > 0x1F as-is. However, JSON.stringify does NOT sort object keys and does
// NOT normalize `-0.0 → 0.0` — we do that manually.
//
// Object key sort order is **UTF-16 code-unit order** per RFC 8785 §3.2.3.
// `Array.prototype.sort()` without a comparator already returns elements
// "in ascending order, with respect to ... String values according to their
// sequence of UTF-16 code units" (ECMA-262 §22.1.3.27), so the language
// default *is* the conformant choice. Earlier versions of this binding
// supplied an explicit `compareUtf8Bytes` comparator in pursuit of parity
// with the (then non-conformant) Python / Go bindings; that parity was wrong
// (config-spec issue #29 / PR #30), and removing the override makes this
// binding conformant by leveraging JS's native behaviour.

import { ConfigError, ConfigErrorReason } from "./errors.js";
import type { JsonValue } from "./types.js";

export type { JsonValue };

// RFC 8785 §3.2.2.3 + _meta/canonical_json.yaml limits.
const MAX_SAFE_INT = Number.MAX_SAFE_INTEGER;
const MIN_SAFE_INT = Number.MIN_SAFE_INTEGER;

/**
 * Serializes value to Canonical JSON (UTF-8 string, without trailing newline).
 * Bit-identical output across all dagstack/config-spec bindings.
 */
export function canonicalize(value: JsonValue, path = ""): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return canonicalizeNumber(value, path);
  if (typeof value === "string") return canonicalizeString(value);
  if (Array.isArray(value)) return canonicalizeArray(value, path);
  if (typeof value === "object") return canonicalizeObject(value, path);

  // Unreachable under strict typing, but we guard the runtime for cases where
  // value comes through `any` / an unsafe cast.
  throw new ConfigError({
    path,
    reason: ConfigErrorReason.TYPE_MISMATCH,
    details: `cannot canonicalize value of type ${typeof value}`,
  });
}

function canonicalizeNumber(n: number, path: string): string {
  if (Number.isNaN(n)) {
    throw new ConfigError({
      path,
      reason: ConfigErrorReason.TYPE_MISMATCH,
      details: "NaN is not allowed in canonical JSON (RFC 8785)",
    });
  }
  if (!Number.isFinite(n)) {
    throw new ConfigError({
      path,
      reason: ConfigErrorReason.TYPE_MISMATCH,
      details: "Infinity is not allowed in canonical JSON (RFC 8785)",
    });
  }

  // `-0.0` → `0` (RFC 8785 §3.2.2.3 + v2.1 `_meta/canonical_json.yaml`
  // integer-form for whole-number floats). `Number.isInteger(-0)` is true and
  // `-0 === 0` is true, so this is a nice normalization step.
  if (n === 0) return "0";

  if (Number.isInteger(n)) {
    // Integer in the safe range: decimal with no fractional part and no
    // leading zeros. JSON.stringify already produces an identical output for
    // integers in the safe range. This also covers whole-number floats via
    // Number.isInteger, matching Python's `_normalize` (ADR v2.1 §9.1.1
    // clarification) and Go's FormatFloat('g') for integer values.
    if (n >= MIN_SAFE_INT && n <= MAX_SAFE_INT) {
      return JSON.stringify(n);
    }
    // Outside the safe range it is still valid JSON, but cross-binding
    // bit-identity is not guaranteed. We emit silently (pure function).
    return JSON.stringify(n);
  }

  // Fractional floats: JSON.stringify gives the shortest round-trip per
  // ECMA-262. Known cross-binding divergence with Python in exponential
  // notation:
  //   JS:     1e-7  → "1e-7"     Python:  1e-7  → "1e-07"
  //   JS:     1e20  → "100000000000000000000"   Python: 1e20 → "1e+20"
  // The current bit-identity is limited to fractional floats in the range
  // |x| ∈ [1e-6, 1e21). The regression guard test pins the current JS
  // behavior; an ADR amendment in config-spec for a cross-binding float
  // format is a follow-up (not a blocker for v0.1.0; extreme floats are
  // intentionally excluded from fixtures).
  return JSON.stringify(n);
}

// Strings: JSON.stringify performs minimal escaping (control chars < 0x20 via
// \uXXXX, backslash, quote) and passes the rest of Unicode through as-is.
// Exactly what _meta/canonical_json.yaml:25 prescribes.
function canonicalizeString(s: string): string {
  return JSON.stringify(s);
}

function canonicalizeArray(arr: readonly JsonValue[], path: string): string {
  const items = arr.map((item, i) => canonicalize(item, appendIndex(path, i)));
  return `[${items.join(",")}]`;
}

function canonicalizeObject(obj: Record<string, JsonValue>, path: string): string {
  // Sort by the JS language default — UTF-16 code-unit order per ECMA-262
  // §22.1.3.27 — which is exactly what RFC 8785 §3.2.3 mandates.
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const valuePath = appendKey(path, key);
    const rawValue = obj[key];
    if (rawValue === undefined) {
      throw new ConfigError({
        path: valuePath,
        reason: ConfigErrorReason.TYPE_MISMATCH,
        details: "undefined is not a valid JSON value; use null explicitly",
      });
    }
    parts.push(`${canonicalizeString(key)}:${canonicalize(rawValue, valuePath)}`);
  }
  return `{${parts.join(",")}}`;
}

function appendIndex(path: string, i: number): string {
  return path === "" ? `[${i.toString()}]` : `${path}[${i.toString()}]`;
}

function appendKey(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}
