// ConfigSource interface + YamlFileSource / JsonFileSource / InMemorySource.
//
// ADR-0001 §8 Phase 1 source contract: `id`, `interpolate` hint, `load()`.
// Watcher / Closer — Phase 2 (not implemented in v0.1.0).
//
// Env interpolation runs OVER the raw text BEFORE parsing — the same order
// as in config-python/config-go: it lets `${VAR}` appear in non-string YAML
// positions (int / bool), where after interpolation the YAML parser itself
// determines the type.

import { readFile } from "node:fs/promises";
import { parse as parseYaml, YAMLParseError } from "yaml";

import { ConfigError, ConfigErrorReason } from "./errors.js";
import { interpolate, type EnvMap } from "./interpolation.js";
import { walkSecretRefs } from "./secret-grammar.js";
import type { ConfigTree, ConfigValue } from "./types.js";

/**
 * Contract for a configuration source (ADR-0001 §8).
 *
 * Implementors MUST expose `id` (a URI-style identifier for diagnostics)
 * and the `interpolate` hint.
 *
 * **About `interpolate` in Phase 1**: `Config.loadFrom` itself does NOT
 * READ this flag — built-in sources apply interpolation themselves inside
 * `load()` over the raw text before parsing. The flag is reserved for
 * Phase 2, when the loader will be able to apply `interpolate()` to an
 * already parsed tree (useful for custom sources that returned a tree
 * with template strings). Authors of custom sources: set
 * `interpolate = false` and interpolate yourselves inside `load()`.
 *
 * `load()` returns the parsed tree or throws a `ConfigError` with a
 * populated `sourceId`.
 */
export interface ConfigSource {
  readonly id: string;
  readonly interpolate: boolean;
  load(): Promise<ConfigTree>;
}

/**
 * Options for `YamlFileSource` / `JsonFileSource`.
 *
 * `env` is an optional override for interpolation. By default it is
 * `process.env`. Passing `{}` means "empty env" (variables cannot be
 * resolved), useful in tests for isolation from the process environment.
 */
export interface FileSourceOptions {
  env?: EnvMap;
}

// i-JSON safe integer range per RFC 7493 §2.2 / config-spec v2.1 §4.3.
// A whole-number float in this range is normalized to an integer for
// uniformity: `100` and `100.0` in YAML/JSON have the same type (`number`)
// after load. Parity with config-python `_normalize_numbers` and the
// config-go YAML/JSON normalize step.
const IJSON_SAFE_MAX = Number.MAX_SAFE_INTEGER; // 2^53 - 1

/**
 * YAML file source. The raw text is read via fs, and `${VAR}` interpolation
 * is applied before YAML parsing — so `port: ${PORT}` with `PORT=8080`
 * yields `{ port: 8080 }` (number), not `{ port: "8080" }`.
 */
export class YamlFileSource implements ConfigSource {
  readonly id: string;
  readonly interpolate: boolean = true;

  private readonly path: string;
  private readonly env: EnvMap;

  constructor(path: string, options: FileSourceOptions = {}) {
    this.path = path;
    this.id = `yaml:${path}`;
    this.env = options.env ?? process.env;
  }

  async load(): Promise<ConfigTree> {
    const raw = await readFileWithSourceError(this.path, this.id);
    const interpolated = interpolate(raw, this.env);
    let parsed: unknown;
    try {
      parsed = parseYaml(interpolated);
    } catch (err) {
      const detail = err instanceof YAMLParseError ? err.message : String(err);
      throw new ConfigError({
        path: "",
        reason: ConfigErrorReason.PARSE_ERROR,
        details: `YAML parse error in ${this.path}: ${detail}`,
        sourceId: this.id,
      });
    }
    return walkSecretRefs(coerceRoot(normalizeNumbers(parsed), this.id), this.id) as ConfigTree;
  }
}

/**
 * JSON file source. Same semantics as YAML — JSON is a subset of YAML 1.2,
 * but a dedicated parser is faster and produces precise errors for
 * JSON-only sources (terraform output, CI-generated config).
 */
export class JsonFileSource implements ConfigSource {
  readonly id: string;
  readonly interpolate: boolean = true;

  private readonly path: string;
  private readonly env: EnvMap;

  constructor(path: string, options: FileSourceOptions = {}) {
    this.path = path;
    this.id = `json:${path}`;
    this.env = options.env ?? process.env;
  }

  async load(): Promise<ConfigTree> {
    const raw = await readFileWithSourceError(this.path, this.id);
    const interpolated = interpolate(raw, this.env);
    let parsed: unknown;
    try {
      parsed = JSON.parse(interpolated);
    } catch (err) {
      throw new ConfigError({
        path: "",
        reason: ConfigErrorReason.PARSE_ERROR,
        details: `JSON parse error in ${this.path}: ${(err as Error).message}`,
        sourceId: this.id,
      });
    }
    return walkSecretRefs(coerceRoot(normalizeNumbers(parsed), this.id), this.id) as ConfigTree;
  }
}

/**
 * Programmatic in-memory source. Interpolation is disabled by default
 * (the tree already has correct structure and types); an explicit
 * `interpolate: true` provides a hint for the loader (unused in Phase 1
 * — reserved).
 */
export class InMemorySource implements ConfigSource {
  readonly id: string;
  readonly interpolate: boolean;

  private readonly tree: ConfigTree;

  constructor(tree: ConfigTree, options: { id?: string; interpolate?: boolean } = {}) {
    this.tree = tree;
    this.id = options.id ?? "in-memory";
    this.interpolate = options.interpolate ?? false;
  }

  load(): Promise<ConfigTree> {
    // Shallow copy — the merge layer performs a deep copy when assembling
    // the final tree. Walk for `${secret:...}` placeholders, same as
    // file sources (ADR-0002 §3).
    const copied =
      typeof this.tree === "object" && this.tree !== null && !Array.isArray(this.tree)
        ? { ...this.tree }
        : this.tree;
    return Promise.resolve(walkSecretRefs(copied, this.id) as ConfigTree);
  }
}

// ── internals ──────────────────────────────────────────────────────

async function readFileWithSourceError(path: string, sourceId: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError({
      path: "",
      reason: ConfigErrorReason.SOURCE_UNAVAILABLE,
      details: `cannot read ${path}: ${(err as Error).message}`,
      sourceId,
    });
  }
}

function coerceRoot(parsed: unknown, sourceId: string): ConfigTree {
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError({
      path: "",
      reason: ConfigErrorReason.PARSE_ERROR,
      details: `root must be a mapping, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
      sourceId,
    });
  }
  return parsed as ConfigTree;
}

/**
 * Recursively coerces whole-number floats in the i-JSON safe range to
 * integers, so YAML/JSON sources return uniform types. Parity with
 * config-python `_normalize_numbers` (§4.3 v2.1 + `_meta/coercion.yaml`).
 *
 * In JS `100 === 100.0` (both are Number), and `Number.isInteger(100.0)`
 * already returns `true`, so this normalization is a contractual parity
 * step rather than an actual type conversion. The function is kept in
 * the code to make the invariants explicit: every `number` after load
 * passes through an `isInteger`-equivalent check.
 *
 * Belt-and-suspenders: `canonical-json.ts` re-normalizes on emit, so the
 * presence of the normalize step here is not dead code — it provides
 * correct types for downstream consumers (zod / pydantic-style schema
 * validation).
 */
function normalizeNumbers(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => normalizeNumbers(v));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeNumbers(v);
    }
    return out;
  }
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value === Math.trunc(value) &&
    Math.abs(value) <= IJSON_SAFE_MAX
  ) {
    // `Math.trunc(-0.0)` → `-0`; `+ 0` converts `-0` → `+0` (RFC 8785
    // §3.2.2.3: negative-zero normalization). A whole-number float in the
    // safe range becomes an integer-form number.
    return Math.trunc(value) + 0;
  }
  return value;
}

// Re-export the types for ergonomics: `import { YamlFileSource, ConfigTree }`
// from a single module.
export type { ConfigValue, ConfigTree };
