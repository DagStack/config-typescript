// Phase 2 secret references and SecretSource adapters (ADR-0002 §2/§3/§4).
//
// Public API (re-exported from `@dagstack/config`):
//
//     import {
//         SecretSource, SecretRef, SecretValue, ResolveContext,
//         EnvSecretSource,
//     } from "@dagstack/config";
//
// `VaultSource` lives in `@dagstack/config` (re-exported from the same
// package; constructing it requires the `node-vault` peer dependency to
// be installed). See `adr/0001-vault-source.md` for the SDK choice.
//
// Resolution timing — see ADR-0002 §3:
// - File sources emit `SecretRef` placeholders at `Source.load()` time.
// - TypeScript binds eagerly: `Config.loadFrom(...)` walks the merged
//   tree and resolves every placeholder before returning. Vault
//   round-trips happen during `loadFrom`. This trades startup latency
//   for the guarantee that all `get*` calls on the resulting `Config`
//   are synchronous and free of resolution failures (the alternative
//   lazy mode that Python exposes does not have a TypeScript counterpart
//   in Phase 2).
//
// Caching — see ADR-0002 §3:
// - Resolved values are cached as a deep-cloned merged tree for the
//   lifetime of the `Config` instance. Within a single resolution walk,
//   refs sharing the same `<scheme>:<full-ref-path>` key produce one
//   backend round-trip; adapters MAY add their own internal cache for
//   `#field` projections of the same backend secret.
// - `SecretValue.expiresAt` is carried through the resolution path but
//   the eager TS binding does not auto-refresh on expiry — operators
//   schedule `Config.refreshSecrets()` (e.g. via `setInterval`) when
//   honouring TTL. Push-based rotation lands in Phase 3.
// - `Config.refreshSecrets()` drops the resolved tree and re-walks the
//   originals against the registered SecretSources — the manual
//   rotation hook (ADR-0002 §3 "Forced refresh").

import { ConfigError, ConfigErrorReason } from "./errors.js";

/**
 * Adapter contract for secret backends per ADR-0002 §2.
 *
 * Distinct from `ConfigSource`: secrets resolve lazily by key, not
 * eagerly as a tree.
 *
 * Phase 2 normative implementations: `EnvSecretSource` (mandatory) and
 * `VaultSource` (optional, ships in `@dagstack/config/vault` as a
 * peer-dependency on `node-vault`).
 */
export interface SecretSource {
  /** Short scheme name; matches the leading token in `${secret:<scheme>:...}`. */
  readonly scheme: string;
  /** Human-readable identifier (URI-style). Carried in diagnostics. */
  readonly id: string;
  /** Resolve a path to a SecretValue. */
  resolve(path: string, ctx: ResolveContext): Promise<SecretValue>;
  /** Optional: release resources (HTTP pool, lease task). */
  close?(): Promise<void>;
}

/**
 * Async-flavoured parallel protocol used by Python only — TypeScript
 * already encodes async semantics through `Promise<T>` so the single
 * `SecretSource` interface covers both. Re-exported as an alias for
 * cross-binding parity (per `_meta/types.yaml`).
 */
export type AsyncSecretSource = SecretSource;

/**
 * Opaque placeholder for an unresolved `${secret:...}` reference.
 *
 * Lives in the merged config tree mixed with regular scalars after
 * `Config.loadFrom(...)`. Resolved transparently by `get*` methods via
 * the `SecretSource` registered for `scheme`.
 *
 * Equality: deep-equal `scheme`, `path`, and `default` are equal;
 * `originSource` is diagnostic-only and does not participate in
 * equality (compare via `secretRefEquals`).
 */
export interface SecretRef {
  readonly __secretRef: true;
  readonly scheme: string;
  readonly path: string;
  readonly default: string | undefined;
  readonly originSource: string;
}

/** Build a SecretRef placeholder. */
export function makeSecretRef(init: {
  scheme: string;
  path: string;
  default?: string | undefined;
  originSource?: string;
}): SecretRef {
  return Object.freeze({
    __secretRef: true,
    scheme: init.scheme,
    path: init.path,
    default: init.default,
    originSource: init.originSource ?? "",
  });
}

/** Type-guard for SecretRef leaves in the merged tree. */
export function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === "object" &&
    value !== null &&
    Boolean((value as Partial<SecretRef>).__secretRef)
  );
}

/**
 * The result of `SecretSource.resolve(path, ctx)`.
 *
 * `value` is always a string at the wire level — type coercion happens
 * at the `Config.get*` call site, exactly like for env-interpolated
 * values (ADR-0001 §4.4).
 */
export interface SecretValue {
  readonly value: string;
  readonly sourceId: string;
  readonly version?: string;
  readonly expiresAt?: Date;
}

/**
 * Per-call context object passed to `SecretSource.resolve`.
 *
 * `signal` is a standard `AbortSignal` — the loader passes
 * cancellation through untouched; adapters MAY honour it or ignore it.
 * `attempt` is 1-based and incremented monotonically by the loader on
 * retry. Adapters MAY read it to pick a longer per-attempt timeout;
 * the loader itself does not implement automatic retries (ADR-0002
 * §Open-questions 4).
 */
export interface ResolveContext {
  attempt: number;
  deadline?: Date;
  signal?: AbortSignal;
}

// ── Built-in EnvSecretSource ──────────────────────────────────────

/** Lookup function for env-var resolution (testable seam). */
export type EnvLookup = (name: string) => string | undefined;

/**
 * In-process SecretSource for the mandatory `env` scheme.
 *
 * `${secret:env:VAR}` is semantically identical to `${VAR}` from
 * ADR-0001 §2 — the env scheme is a degenerate case of secret
 * resolution. Auto-registered by the loader if the consumer does not
 * pass one explicitly (ADR-0002 §4 rule 2).
 *
 * The env scheme operates on env-var names; it does not support the
 * `?query` or `#field` projection (env values are opaque single-value
 * strings). If an operator tries to use them, the source raises
 * `secret_unresolved` with an actionable hint pointing at structured
 * backends (such as Vault).
 */
export class EnvSecretSource implements SecretSource {
  readonly scheme = "env";
  readonly id = "env:process.env";
  private readonly lookup: EnvLookup;

  constructor(options?: { lookup?: EnvLookup }) {
    this.lookup = options?.lookup ?? ((name: string): string | undefined => process.env[name]);
  }

  resolve(path: string, _ctx: ResolveContext): Promise<SecretValue> {
    for (const [sep, hint] of [
      ["?", "query parameters"],
      ["#", "sub-key projection"],
    ] as const) {
      if (path.includes(sep)) {
        return Promise.reject(
          new ConfigError({
            path: "",
            reason: ConfigErrorReason.SECRET_UNRESOLVED,
            details:
              `env scheme does not support ${hint} ('${sep}' in ${JSON.stringify(path)}); ` +
              "env values are opaque single-value strings — switch to a backend with " +
              "structured secrets (e.g. VaultSource for HashiCorp Vault KV v2) " +
              "if you need them.",
            sourceId: this.id,
          }),
        );
      }
    }

    const value = this.lookup(path);
    if (value === undefined) {
      return Promise.reject(
        new ConfigError({
          path: "",
          reason: ConfigErrorReason.SECRET_UNRESOLVED,
          details: `env:${path} is not set in the process environment and the reference has no default`,
          sourceId: this.id,
        }),
      );
    }
    return Promise.resolve({ value, sourceId: this.id });
  }
}
