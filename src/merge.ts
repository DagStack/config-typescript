// Deep merge (ADR-0001 §3).
//
// Semantics:
//   - Objects (plain objects / Maps) — merged recursively by key.
//   - Arrays — replaced as a whole (they are not concatenated). This is the
//     "atomic replace" of §3; to change a single array element, the override
//     file must contain the entire array.
//   - Scalars (string/number/boolean/null) — override overwrites base.
//   - Type mismatch (base = object, override = scalar) — override wins.
//
// Immutability: the result is a fully detached tree. No nested node is shared
// by reference with either base or override. This is critical for Phase C
// reload/swap, where the prev-tree and next-tree must be independent
// (a subscriber callback holding a reference to prev must not see next values).

import type { ConfigTree, ConfigValue } from "./types.js";

export type { ConfigTree, ConfigValue };

function isPlainObject(value: unknown): value is Record<string, ConfigValue> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  // Reject class instances (Map, Set, Date, etc.) — we expect only
  // literal-shaped objects from the YAML / JSON parsers.
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Recursive deep clone of a tree. Primitives are immutable and are returned
 * as-is. Arrays / objects are copied structurally.
 */
export function deepClone(value: ConfigValue): ConfigValue {
  if (value === null) return null;
  if (typeof value !== "object") return value; // primitives immutable
  if (Array.isArray(value)) return value.map(deepClone);
  const result: Record<string, ConfigValue> = {};
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v !== undefined) result[key] = deepClone(v);
  }
  return result;
}

/**
 * Deep-merges two trees. The right side (override) takes precedence.
 * Returns a brand-new tree — no node is shared with the inputs.
 */
export function deepMerge(base: ConfigValue, override: ConfigValue): ConfigValue {
  // If override is a plain object and base is too — merge recursively.
  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, ConfigValue> = {};
    // Keys from base: clone so the result does not share references with base.
    for (const key of Object.keys(base)) {
      const value = base[key];
      if (value !== undefined) result[key] = deepClone(value);
    }
    // Keys from override — override wins; on a collision, recursively merge
    // with the already-cloned base value.
    for (const key of Object.keys(override)) {
      const overrideValue = override[key];
      if (overrideValue === undefined) continue;
      const baseValue = result[key];
      if (baseValue === undefined) {
        // Override-only key — clone the override so the result is detached
        // from override as well.
        result[key] = deepClone(overrideValue);
      } else {
        // Both present — recursive merge (recursion will clone where needed).
        result[key] = deepMerge(baseValue, overrideValue);
      }
    }
    return result;
  }

  // In any other case — override wins outright (arrays included).
  // An array on override is replaced as a whole; this is ADR §3
  // "lists replaced atomically". deepClone ensures the result is detached
  // from override.
  return deepClone(override);
}

/**
 * Merges a list of trees left-to-right (base = layers[0], priority grows).
 * An empty list returns {} (an empty object as the neutral element).
 */
export function deepMergeAll(layers: readonly ConfigValue[]): ConfigValue {
  if (layers.length === 0) return {};
  const first = layers[0];
  if (first === undefined) return {}; // unreachable given the length check
  let acc: ConfigValue = deepClone(first); // clone the initial value so we do not mutate inputs.
  for (let i = 1; i < layers.length; i++) {
    const next = layers[i];
    if (next === undefined) continue;
    acc = deepMerge(acc, next);
  }
  return acc;
}
