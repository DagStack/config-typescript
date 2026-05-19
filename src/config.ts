// Config class: load, loadFrom, primitive getters, getSection(zodSchema).
//
// ADR-0001 §4. Implementation follows config-go and config-python v0.2.0:
//   - get / has / getString / getInt / getNumber / getBool / getList — strict
//     coercion per §4.3 (no int/float/bool → str coercion in getString).
//   - getSection parses a sub-tree through a user-supplied zod schema.
//   - load(path) performs auto-discovery of layers `path.local.yaml` and
//     `path.${DAGSTACK_ENV}.yaml` (silently skipped if the file is missing).
//   - loadFrom(sources) deep-merges in order (later overrides earlier).
//
// Phase 2: Watcher / OnChange / Close — the API surface is reserved here;
// implementations land in v0.2+.

import path from "node:path";
import type { z } from "zod";

import { ConfigError, ConfigErrorReason } from "./errors.js";
import { deepClone, deepMergeAll } from "./merge.js";
import { getByPath, hasPath, parsePath } from "./paths.js";
import { coerceEnvStringsForSchema } from "./section-coerce.js";
import {
  EnvSecretSource,
  isSecretRef,
  type ResolveContext,
  type SecretSource,
  type SecretValue,
} from "./secrets.js";
import { MASKED_PLACEHOLDER, isSecretField } from "./secrets-mask.js";
import { YamlFileSource, type ConfigSource, type FileSourceOptions } from "./sources.js";
import type { ConfigTree, ConfigValue } from "./types.js";

// i-JSON safe range per RFC 7493 §2.2 / v2.1 §4.3. A whole-number value in
// this range is accepted by `getInt` as an integer.
const IJSON_SAFE_MAX = Number.MAX_SAFE_INTEGER;

// Unique marker for "default not provided" in *OrDefault semantics.
// `undefined` cannot be used — it is a valid default.
const MISSING = Symbol("missing");

/** Options for `Config.load()`. */
export interface LoadOptions extends FileSourceOptions {
  /**
   * Value of `DAGSTACK_ENV`; by default taken from `process.env`.
   * Passing `null` disables the env-specific layer.
   */
  dagstackEnv?: string | null;
}

/**
 * The main binding class. Holds the merged configuration tree and exposes
 * strict typed getters.
 *
 * Instances are created through `Config.load(path, options)` or
 * `Config.loadFrom(sources)`; the constructor is not meant to be used
 * directly (it is reserved for Phase 2 runtime reload).
 */
export class Config {
  private tree: ConfigTree;
  private readonly originalTree: ConfigTree;
  private readonly secretSources: ReadonlyMap<string, SecretSource>;
  private readonly sources: readonly ConfigSource[];

  private constructor(
    tree: ConfigTree,
    originalTree: ConfigTree,
    secretSources: ReadonlyMap<string, SecretSource>,
    sources: readonly ConfigSource[],
  ) {
    this.tree = tree;
    this.originalTree = originalTree;
    this.secretSources = secretSources;
    this.sources = sources;
  }

  /**
   * Auto-discovery loader. Reads the base `<path>` (YAML), then — if they
   * exist — the override layers `<path-without-.yaml>.local.yaml` and
   * `<path-without-.yaml>.${DAGSTACK_ENV}.yaml`. Missing layers are silently
   * skipped.
   */
  static async load(filePath: string, options: LoadOptions = {}): Promise<Config> {
    const baseSource = new YamlFileSource(
      filePath,
      options.env === undefined ? {} : { env: options.env },
    );
    const stem = stripYamlExt(filePath);

    const localPath = `${stem}.local.yaml`;
    const envValue =
      options.dagstackEnv === undefined ? process.env.DAGSTACK_ENV : options.dagstackEnv;
    const envPath = envValue ? `${stem}.${envValue}.yaml` : null;

    const sources: ConfigSource[] = [baseSource];

    if (await fileExists(localPath)) {
      sources.push(
        new YamlFileSource(localPath, options.env === undefined ? {} : { env: options.env }),
      );
    }
    if (envPath !== null && (await fileExists(envPath))) {
      sources.push(
        new YamlFileSource(envPath, options.env === undefined ? {} : { env: options.env }),
      );
    }

    return Config.loadFrom(sources);
  }

  /**
   * Explicit loader: sources are listed in priority order (last has the
   * highest priority). All layers are deep-merged. Source errors are
   * re-thrown with `sourceId`.
   *
   * Accepts a heterogeneous list of `ConfigSource` (provides the tree)
   * and `SecretSource` (resolves `${secret:<scheme>:...}` references)
   * per ADR-0002 §4. `ConfigSource` order defines merge priority;
   * `SecretSource` order does not — each scheme has at most one
   * registered source. If no `SecretSource` is passed, an
   * `EnvSecretSource` is auto-registered for the `env` scheme.
   *
   * **Eager resolution.** Getters on `Config` are sync, so the loader
   * pays the async cost up front: `loadFrom` walks the merged tree
   * and resolves every `${secret:...}` reference before returning.
   * Vault round-trips happen during `loadFrom`. This is the
   * recommended mode in ADR-0002 §3 for long-lived servers; the
   * lazy mode that Python exposes does not have a TypeScript
   * counterpart in Phase 2.
   *
   * @throws ConfigError(VALIDATION_FAILED) — two `SecretSource` instances
   *   share the same `scheme`.
   * @throws ConfigError(SECRET_UNRESOLVED) — a `${secret:<scheme>:...}`
   *   reference targets an unregistered scheme without a `:-default`,
   *   OR the registered backend rejected the read.
   */
  static async loadFrom(sources: readonly (ConfigSource | SecretSource)[]): Promise<Config> {
    const configSources: ConfigSource[] = [];
    const secretSources = new Map<string, SecretSource>();
    for (const src of sources) {
      if (isSecretSource(src)) {
        const existing = secretSources.get(src.scheme);
        if (existing !== undefined) {
          throw new ConfigError({
            path: "",
            reason: ConfigErrorReason.VALIDATION_FAILED,
            details:
              `duplicate SecretSource scheme: '${src.scheme}' ` +
              `(already registered: '${existing.id}', now adding: '${src.id}')`,
          });
        }
        secretSources.set(src.scheme, src);
      } else {
        configSources.push(src);
      }
    }
    if (!secretSources.has("env")) {
      const envSource = new EnvSecretSource();
      secretSources.set(envSource.scheme, envSource);
    }

    const trees: ConfigValue[] = [];
    for (const src of configSources) {
      trees.push(await src.load());
    }
    const merged = trees.length === 0 ? {} : deepMergeAll(trees);
    if (merged === null || typeof merged !== "object" || Array.isArray(merged)) {
      throw new ConfigError({
        path: "",
        reason: ConfigErrorReason.TYPE_MISMATCH,
        details: "merged configuration root must be a mapping",
      });
    }

    // ADR-0002 §3 / §4: eagerly resolve every SecretRef. The walker
    // also catches unknown-scheme references at load time per §4 rule 3.
    // We retain the original (pre-resolved) tree so `refreshSecrets()`
    // can re-walk it, and `snapshot({includeSecrets:false})` can mask
    // SecretRef placeholders without leaking resolved values.
    const original = deepClone(merged);
    const resolved = await resolveSecretRefs(merged, secretSources);
    return new Config(resolved as ConfigTree, original, secretSources, configSources);
  }

  // ── primitive API ─────────────────────────────────────────────────

  /** Checks whether the path exists in the tree. An explicit `null` is treated as present. */
  has(pathSpec: string): boolean {
    return hasPath(this.tree, parsePath(pathSpec));
  }

  /**
   * Returns the raw value at the path. The second argument is an optional
   * default. Throws `ConfigError(MISSING)` if the path is absent and no
   * default is provided.
   */
  get(pathSpec: string, defaultValue: unknown = MISSING): unknown {
    const segments = parsePath(pathSpec);
    if (!hasPath(this.tree, segments)) {
      if (defaultValue === MISSING) throw missingError(pathSpec);
      return defaultValue;
    }
    return getByPath(this.tree, segments);
  }

  /**
   * Strict string getter. Does NOT coerce number/boolean/null/object into a
   * string — per ADR v2.1 §4.3. For explicit conversion use
   * `String(cfg.get(path))`.
   */
  getString(pathSpec: string, defaultValue: string | typeof MISSING = MISSING): string {
    const value = this.tryGet(pathSpec, defaultValue);
    if (value === defaultValue) return defaultValue as string;
    if (typeof value !== "string") {
      throw typeMismatchError(pathSpec, "string", value);
    }
    return value;
  }

  /**
   * Integer getter. Accepts:
   *   - `number` with `Number.isInteger(n)` in the safe range (`±(2^53-1)`);
   *   - a numeric string matching `^-?\d+$`.
   * Booleans and fractional numbers are rejected.
   */
  getInt(pathSpec: string, defaultValue: number | typeof MISSING = MISSING): number {
    const value = this.tryGet(pathSpec, defaultValue);
    if (value === defaultValue) return defaultValue as number;
    if (typeof value === "boolean") {
      throw typeMismatchError(pathSpec, "int", value, "bool is not int (v2.1 §4.3)");
    }
    if (typeof value === "number") {
      if (!Number.isInteger(value)) {
        throw typeMismatchError(pathSpec, "int", value, "fractional number is not int");
      }
      if (Math.abs(value) > IJSON_SAFE_MAX) {
        throw typeMismatchError(pathSpec, "int", value, "outside i-JSON safe range (±2^53-1)");
      }
      return value;
    }
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
      return Number.parseInt(value, 10);
    }
    throw typeMismatchError(pathSpec, "int", value);
  }

  /**
   * Number getter (float-compatible). Accepts a `number` (int or float) and
   * a numeric string (including `.` and `e` notation). Booleans are rejected.
   */
  getNumber(pathSpec: string, defaultValue: number | typeof MISSING = MISSING): number {
    const value = this.tryGet(pathSpec, defaultValue);
    if (value === defaultValue) return defaultValue as number;
    if (typeof value === "boolean") {
      throw typeMismatchError(pathSpec, "number", value);
    }
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      if (Number.isNaN(parsed)) {
        throw typeMismatchError(
          pathSpec,
          "number",
          value,
          `string ${JSON.stringify(value)} is not numeric`,
        );
      }
      return parsed;
    }
    throw typeMismatchError(pathSpec, "number", value);
  }

  /**
   * Boolean getter. Accepts `boolean` and the case-insensitive strings
   * `true|false|yes|no|1|0` (spec §4.3). Other values raise TYPE_MISMATCH.
   */
  getBool(pathSpec: string, defaultValue: boolean | typeof MISSING = MISSING): boolean {
    const value = this.tryGet(pathSpec, defaultValue);
    if (value === defaultValue) return defaultValue as boolean;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      if (lower === "true" || lower === "yes" || lower === "1") return true;
      if (lower === "false" || lower === "no" || lower === "0") return false;
      throw typeMismatchError(pathSpec, "bool", value, "expected true|false|yes|no|1|0");
    }
    throw typeMismatchError(pathSpec, "bool", value);
  }

  /**
   * List getter — returns `unknown[]` and has no default (the list is
   * required when accessed). For `Array<T>` use
   * `getSection(path, z.array(z.X))`.
   */
  getList(pathSpec: string): unknown[] {
    const value = this.get(pathSpec);
    if (!Array.isArray(value)) {
      throw typeMismatchError(pathSpec, "array", value);
    }
    return value;
  }

  /**
   * Typed sub-section via a zod schema.
   *
   * ADR-0001 v2.1 §4.4 Typed section access: env-substituted numeric and
   * boolean strings are coerced to schema fields through a walker before
   * zod validation, so `port: "${DB_PORT:-5432}"` in YAML validates
   * successfully against `z.number().int()` in the schema.
   *
   * §4.4 M1 reverse case: a native int/float/bool in a `z.string()` field
   * raises `ConfigError(TYPE_MISMATCH)` with the full dot-notation path
   * `section.field`. This guards against silent `dimension: 768` → `"768"`.
   *
   * §4.5 path preservation: for nested validation failure the path is
   * `<section>.<field>` (concatenated with the zod issue path).
   */
  getSection<T>(pathSpec: string, schema: z.ZodType<T>): T {
    const segments = parsePath(pathSpec);
    if (!hasPath(this.tree, segments)) {
      throw missingError(pathSpec);
    }
    const raw = getByPath(this.tree, segments);
    const coerced = coerceEnvStringsForSchema(raw, schema as z.ZodTypeAny);
    const result = schema.safeParse(coerced);
    if (!result.success) {
      const issue = result.error.issues[0];
      // ADR-0001 v2.2 §4.2 / §4.5: integer segments (array indices) are
      // wrapped in `[N]`, not concatenated with a dot.
      const fullPath = joinZodLoc(pathSpec, issue?.path ?? []);

      // Reverse-coerce check (§4.4 M1): a native non-string scalar in a
      // string field. `received` is a non-normative field on the zod
      // invalid_type issue; we read it safely through an unknown cast.
      let reason: ConfigErrorReason = ConfigErrorReason.VALIDATION_FAILED;
      if (issue?.code === "invalid_type" && issue.expected === "string") {
        const received = (issue as unknown as { received?: string }).received;
        if (received === "number" || received === "bigint" || received === "boolean") {
          reason = ConfigErrorReason.TYPE_MISMATCH;
        }
      }

      // ADR-0001 v2.2 §6: secret masking in details for failed fields.
      let details = `schema validation failed: ${result.error.message}`;
      const leafName = issue?.path.length ? String(issue.path[issue.path.length - 1]) : "";
      if (leafName && isSecretField(leafName)) {
        const input = (issue as unknown as { input?: unknown }).input;
        if (
          (typeof input === "string" && input !== "") ||
          typeof input === "number" ||
          typeof input === "bigint" ||
          typeof input === "boolean"
        ) {
          const strInput = typeof input === "string" ? input : String(input);
          details = details.split(strInput).join(MASKED_PLACEHOLDER);
          details = details
            .split(JSON.stringify(strInput))
            .join(JSON.stringify(MASKED_PLACEHOLDER));
        }
      }

      throw new ConfigError({
        path: fullPath,
        reason,
        details,
      });
    }
    return result.data;
  }

  // ── diagnostics ──────────────────────────────────────────────────

  /**
   * Deep-copy of the merged tree with secret-aware masking
   * (ADR-0002 §3 "Resolution timing" trigger table).
   *
   * Default behaviour (`includeSecrets: false`): every `SecretRef`
   * placeholder in the original tree is replaced with `[MASKED]`,
   * AND every plain string value whose key matches a secret pattern
   * (`_meta/secret_patterns.yaml`, e.g. `api_key`, `password`) is also
   * replaced. No backend round-trip is performed; resolved secret
   * values are NOT exposed.
   *
   * With `includeSecrets: true` — audit-mode opt-in. The fully-
   * resolved tree is returned, with field-name suffix masking still
   * applied. Callers MUST treat the returned object as sensitive.
   *
   * The returned object is a deep clone — mutating it does not
   * affect subsequent `get*` calls.
   */
  snapshot(options: { includeSecrets?: boolean } = {}): ConfigTree {
    const includeSecrets = options.includeSecrets ?? false;
    const source = includeSecrets ? this.tree : this.originalTree;
    return walkSnapshot(source, includeSecrets) as ConfigTree;
  }

  /**
   * Drop the resolved-secrets tree and re-resolve every
   * `${secret:...}` reference against its registered SecretSource
   * (ADR-0002 §3 "Forced refresh"). This is the Phase 2 manual-
   * rotation hook; push-based rotation is deferred to Phase 3.
   *
   * `expiresAt` from `SecretValue` is honoured at refresh time — a
   * cached resolution whose `expiresAt` has passed is skipped within
   * the per-walk dedup cache, so each stale path takes a fresh
   * backend round-trip even if it appears more than once in the
   * tree. The TS-eager binding does not auto-refresh between
   * `refreshSecrets` calls — operators schedule a periodic call
   * (e.g. via `setInterval`) when honouring TTL.
   *
   * Atomic from the caller's perspective: on failure the previously
   * resolved tree remains the active tree, so a caller may safely
   * retry. The internal reference is only swapped after a successful
   * full re-walk.
   *
   * @throws ConfigError(SECRET_UNRESOLVED | SECRET_BACKEND_UNAVAILABLE
   *   | SECRET_PERMISSION_DENIED) — same surface as `loadFrom`.
   */
  async refreshSecrets(): Promise<void> {
    const resolved = await resolveSecretRefs(this.originalTree, this.secretSources);
    this.tree = resolved as ConfigTree;
  }

  /** Source ids in load order. Useful for logging and diagnostics. */
  sourceIds(): readonly string[] {
    return this.sources.map((s) => s.id);
  }

  // ── internals ────────────────────────────────────────────────────

  private tryGet(pathSpec: string, defaultValue: unknown): unknown {
    const segments = parsePath(pathSpec);
    if (!hasPath(this.tree, segments)) {
      if (defaultValue !== MISSING) return defaultValue;
      throw missingError(pathSpec);
    }
    return getByPath(this.tree, segments);
  }
}

// ── helpers (private) ────────────────────────────────────────────────

/**
 * Builds the full dot-notation path from the section prefix and the zod
 * issue path. ADR-0001 v2.2 §4.2 / §4.5: integer segments are wrapped in `[N]`.
 */
function joinZodLoc(section: string, loc: readonly (string | number)[]): string {
  if (loc.length === 0) return section;
  const parts: string[] = section ? [section] : [];
  for (const seg of loc) {
    if (typeof seg === "number") {
      if (parts.length > 0) {
        parts[parts.length - 1] = `${parts[parts.length - 1]}[${seg}]`;
      } else {
        parts.push(`[${seg}]`);
      }
    } else {
      parts.push(seg);
    }
  }
  return parts.join(".");
}

function stripYamlExt(file: string): string {
  const ext = path.extname(file);
  return ext === ".yaml" || ext === ".yml" ? file.slice(0, -ext.length) : file;
}

/**
 * Type-narrowing predicate for `SecretSource` instances. We do not use
 * `instanceof` (the Protocol is structural — adapters need not extend a
 * common base class); instead we duck-type on `scheme` / `id` / `resolve`.
 */
function isSecretSource(value: ConfigSource | SecretSource): value is SecretSource {
  return (
    typeof (value as SecretSource).scheme === "string" &&
    typeof (value as SecretSource).resolve === "function"
  );
}

/**
 * Walk the merged tree, replacing every `SecretRef` with the resolved
 * string value via the registered SecretSource. Adapters that fetch
 * a multi-key envelope from a backend may keep their own internal
 * cache for two refs to different `#field` projections of the same key.
 */
async function resolveSecretRefs(
  tree: unknown,
  secretSources: ReadonlyMap<string, SecretSource>,
): Promise<unknown> {
  const cache = new Map<string, SecretValue>();
  return walk(tree);

  async function walk(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        out.push(await walk(item));
      }
      return out;
    }
    if (value !== null && typeof value === "object" && !isSecretRef(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = await walk(v);
      }
      return out;
    }
    if (isSecretRef(value)) {
      const cacheKey = `${value.scheme}:${value.path}`;
      const cached = cache.get(cacheKey);
      // ADR-0002 §3 cache rule: a SecretValue with `expiresAt` in the
      // past is a cache miss. `expiresAt === undefined` means cache for
      // the resolution-walk lifetime.
      if (cached !== undefined && !isExpired(cached.expiresAt)) {
        return cached.value;
      }

      const source = secretSources.get(value.scheme);
      if (source === undefined) {
        if (value.default !== undefined) return value.default;
        throw new ConfigError({
          path: "",
          reason: ConfigErrorReason.SECRET_UNRESOLVED,
          details:
            `no SecretSource registered for scheme '${value.scheme}' ` +
            `(referenced from '${value.originSource}'); ` +
            `available schemes: [${[...secretSources.keys()]
              .sort()
              .map((k) => `'${k}'`)
              .join(", ")}]`,
        });
      }

      let resolved: SecretValue;
      try {
        const ctx: ResolveContext = { attempt: 1 };
        resolved = await source.resolve(value.path, ctx);
      } catch (err) {
        if (value.default !== undefined && err instanceof ConfigError) {
          return value.default;
        }
        throw err;
      }
      cache.set(cacheKey, resolved);
      return resolved.value;
    }
    return value;
  }
}

/**
 * ADR-0002 §3 cache rule: a SecretValue with `expiresAt` in the past
 * is a cache miss. `expiresAt === undefined` means cache for the
 * resolution-walk lifetime.
 */
function isExpired(expiresAt: Date | undefined): boolean {
  if (expiresAt === undefined) return false;
  return expiresAt.getTime() <= Date.now();
}

/**
 * Snapshot walker — masks SecretRef placeholders (when not including
 * secrets) and field-name-pattern matches (always). Mirrors
 * `Config.snapshot()` from ADR-0002 §3 trigger table semantics.
 */
function walkSnapshot(value: unknown, includeSecrets: boolean, key = ""): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => walkSnapshot(v, includeSecrets, key));
  }
  if (isSecretRef(value)) {
    return MASKED_PLACEHOLDER;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = walkSnapshot(v, includeSecrets, k);
    }
    return out;
  }
  if (typeof value === "string" && value !== "" && isSecretField(key)) {
    return MASKED_PLACEHOLDER;
  }
  return value;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    const s = await stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

function missingError(pathSpec: string): ConfigError {
  return new ConfigError({
    path: pathSpec,
    reason: ConfigErrorReason.MISSING,
    details: `path '${pathSpec}' not found in configuration`,
  });
}

function typeMismatchError(
  pathSpec: string,
  expected: string,
  got: unknown,
  extra = "",
): ConfigError {
  const gotType = got === null ? "null" : Array.isArray(got) ? "array" : typeof got;
  const suffix = extra === "" ? "" : ` (${extra})`;
  return new ConfigError({
    path: pathSpec,
    reason: ConfigErrorReason.TYPE_MISMATCH,
    details: `expected ${expected}, got ${gotType}${suffix}`,
  });
}
