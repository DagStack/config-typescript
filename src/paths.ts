// Dot-notation path addressing (ADR-0001 §4.2).
//
// Grammar:
//   path     := segment ("." segment | "[" index "]")*
//   segment  := key
//   key      := char+   (where "." inside a key is escaped with a backslash)
//   index    := integer | "*"
//
// Examples:
//   database.host             → [{key:"database"}, {key:"host"}]
//   dagstack.plugin_dirs[0]   → [{key:"dagstack"}, {key:"plugin_dirs"}, {index:0}]
//   dagstack.plugin_dirs[*]   → [{key:"dagstack"}, {key:"plugin_dirs"}, {index:"*"}]
//   labels.kubernetes\.io/zone
//     → [{key:"labels"}, {key:"kubernetes.io/zone"}]

import { ConfigError, ConfigErrorReason } from "./errors.js";

export interface KeySegment {
  readonly kind: "key";
  readonly value: string;
}

export interface IndexSegment {
  readonly kind: "index";
  readonly value: number | "*";
}

export type PathSegment = KeySegment | IndexSegment;

/**
 * Parses a dot-notation path into an array of segments.
 * An empty string returns an empty array (referring to the root).
 */
export function parsePath(path: string): PathSegment[] {
  if (path === "") return [];

  const segments: PathSegment[] = [];
  let i = 0;
  const n = path.length;

  while (i < n) {
    // Skip the leading dot (between segments).
    if (path.charAt(i) === ".") {
      if (i === 0 || segments.length === 0) {
        throw new ConfigError({
          path,
          reason: ConfigErrorReason.PARSE_ERROR,
          details: `unexpected '.' at position ${i.toString()}`,
        });
      }
      i++;
      if (i >= n) {
        throw new ConfigError({
          path,
          reason: ConfigErrorReason.PARSE_ERROR,
          details: "trailing '.' (empty segment)",
        });
      }
    }

    // Array index: [N] or [*].
    if (path.charAt(i) === "[") {
      const close = path.indexOf("]", i);
      if (close === -1) {
        throw new ConfigError({
          path,
          reason: ConfigErrorReason.PARSE_ERROR,
          details: `unclosed '[' at position ${i.toString()}`,
        });
      }
      const inner = path.slice(i + 1, close);
      if (inner === "*") {
        segments.push({ kind: "index", value: "*" });
      } else if (/^\d+$/.test(inner)) {
        const idx = Number(inner);
        if (!Number.isSafeInteger(idx)) {
          throw new ConfigError({
            path,
            reason: ConfigErrorReason.PARSE_ERROR,
            details: `array index '${inner}' exceeds safe integer range (|n| > 2^53 - 1)`,
          });
        }
        segments.push({ kind: "index", value: idx });
      } else {
        throw new ConfigError({
          path,
          reason: ConfigErrorReason.PARSE_ERROR,
          details: `invalid index '${inner}' (expected non-negative integer or '*')`,
        });
      }
      i = close + 1;
      continue;
    }

    // Key segment up to the next unescaped '.' or '['.
    let key = "";
    while (i < n) {
      const ch = path.charAt(i);
      if (ch === "\\" && i + 1 < n) {
        // Backslash escape: the next character is literal.
        key += path.charAt(i + 1);
        i += 2;
        continue;
      }
      if (ch === "." || ch === "[") break;
      key += ch;
      i++;
    }
    if (key === "") {
      throw new ConfigError({
        path,
        reason: ConfigErrorReason.PARSE_ERROR,
        details: `empty key segment at position ${i.toString()}`,
      });
    }
    segments.push({ kind: "key", value: key });
  }

  return segments;
}

/**
 * Returns the value at the given path, or undefined if the path does not exist.
 * Does not throw — this is a predicate-style helper for has()/get() logic.
 */
export function getByPath(tree: unknown, segments: readonly PathSegment[]): unknown {
  let current: unknown = tree;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;

    if (segment.kind === "key") {
      if (typeof current !== "object" || Array.isArray(current)) return undefined;
      const obj = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, segment.value)) return undefined;
      current = obj[segment.value];
      continue;
    }

    // index segment
    if (!Array.isArray(current)) return undefined;
    if (segment.value === "*") {
      // `*` on a container = the entire array. Per ADR §4.2:
      // "dagstack.plugin_dirs[*] — the entire array as a whole (in get/getList)."
      current = (current as unknown[]).slice();
      continue;
    }
    const arr = current as unknown[];
    if (segment.value < 0 || segment.value >= arr.length) return undefined;
    current = arr[segment.value];
  }
  return current;
}

/**
 * Checks whether the path exists in the tree (ADR-0001 §4.3, `config.has(path)`).
 * Treats null specially — a null value in the tree counts as "present"
 * (the key exists with a null value), unlike undefined (the key is absent).
 */
export function hasPath(tree: unknown, segments: readonly PathSegment[]): boolean {
  if (segments.length === 0) return tree !== undefined;

  let current: unknown = tree;
  // Iterate through all but the last segment — these traverse the tree.
  // The last segment is checked separately so we correctly handle a null leaf.
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (segment === undefined) break; // unreachable by bounds, but satisfies TS
    if (current === null || current === undefined) return false;

    if (segment.kind === "key") {
      if (typeof current !== "object" || Array.isArray(current)) return false;
      const obj = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, segment.value)) return false;
      current = obj[segment.value];
      continue;
    }

    if (!Array.isArray(current)) return false;
    if (segment.value === "*") {
      current = (current as unknown[]).slice();
      continue;
    }
    const arr = current as unknown[];
    if (segment.value < 0 || segment.value >= arr.length) return false;
    current = arr[segment.value];
  }

  const finalSeg = segments[segments.length - 1];
  if (finalSeg === undefined) return false; // unreachable — checked above
  if (current === null || current === undefined) return false;
  if (finalSeg.kind === "key") {
    if (typeof current !== "object" || Array.isArray(current)) return false;
    return Object.prototype.hasOwnProperty.call(current, finalSeg.value);
  }
  if (!Array.isArray(current)) return false;
  if (finalSeg.value === "*") return true;
  const arr = current as unknown[];
  return finalSeg.value >= 0 && finalSeg.value < arr.length;
}
