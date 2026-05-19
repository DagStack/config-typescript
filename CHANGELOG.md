# Changelog

All notable changes are recorded in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-05-19

Canonical JSON key sort order aligned with RFC 8785 §3.2.3 — keys
are now ordered by their UTF-16 code-unit sequence (config-spec
ADR-0001 v2.3).

### Fixed

- `canonicalize()` previously sorted object keys with an explicit
  `compareUtf8Bytes` comparator (UTF-8 byte order) in pursuit of
  parity with the older Python and Go bindings. That parity was
  wrong — RFC 8785 §3.2.3 mandates UTF-16 code-unit order, which
  is exactly what `Array.prototype.sort()` without a comparator
  produces per ECMA-262 §22.1.3.27. The explicit comparator (and
  the supporting `UTF8_ENCODER` constant) is removed; the language
  default is conformant and is now used directly.

### Breaking

- Wire bytes change on edge-case key shapes — any object that mixes
  BMP-PUA (U+E000+) keys with supplementary-plane (U+10000+) keys
  will serialize with the two keys in the opposite order. Internal
  Nexus consumers do not produce such keys, so no rollout impact
  observed.

### Spec submodule

- `spec`: 97640b3 → c180592 (config-spec ADR-0001 v2.3 +
  conformance fixture `key_order_drift_witness.json`).

## [0.4.0] — 2026-05-04

Phase 2 secrets — `${secret:<scheme>:<path>}` reference syntax with
pluggable `SecretSource` adapters. Pilot adapter for HashiCorp Vault
KV v2 ships in the same package (peer dependency on `node-vault`).
Spec: ADR-0002.

### Added

- `SecretSource` interface — always async (`resolve` returns
  `Promise<SecretValue>`), since TypeScript has no sync/async split.
  `AsyncSecretSource` is exported as a type alias of `SecretSource`
  for cross-binding source-code parity with `dagstack-config`
  (Python).
- `SecretRef`, `SecretValue`, `ResolveContext` value types for
  references and resolution.
- `EnvSecretSource` — mandatory in-process adapter for the `env`
  scheme. `${secret:env:VAR}` is semantically identical to `${VAR}`
  from ADR-0001 §2 (backwards-compat).
- `VaultSource` — pilot Vault adapter, peer dependency on
  `node-vault`. KV v2 only; `kind: "token"` / `kind: "approle"` /
  `kind: "kubernetes"` auth; namespace support; `?version=N`;
  `#field` projection.
- Three new `ConfigErrorReason` values: `secret_unresolved`,
  `secret_backend_unavailable`, `secret_permission_denied`.
- `Config.loadFrom()` accepts a heterogeneous list of `ConfigSource`
  and `SecretSource` instances. The loader auto-registers
  `EnvSecretSource` if no `SecretSource` is passed; eager scan at
  load time fails fast on unknown schemes per ADR-0002 §4 rule 3.
- **Eager resolution** by default (TS choice per ADR-0002 §3): every
  `SecretRef` is resolved during `loadFrom`. Vault round-trips
  happen before `loadFrom` returns. This trades startup latency for
  the guarantee that `get*` calls on the resulting `Config` are
  synchronous and free of resolution failures.
- `Config.refreshSecrets()` — drops the resolved-secrets tree and
  re-resolves every `${secret:...}` reference against its registered
  `SecretSource` (ADR-0002 §3 "Forced refresh"). Manual rotation
  hook for Phase 2; push-based rotation is deferred to Phase 3.
- `Config.snapshot({ includeSecrets: false })` (default) — masks
  every `SecretRef` placeholder to `[MASKED]` and applies field-name
  suffix masking from `_meta/secret_patterns.yaml`. No backend
  round-trip. `includeSecrets: true` returns the resolved tree with
  field-name suffix masking still applied (audit-mode opt-in per
  ADR-0002 §3 trigger table).
- New per-binding `adr/0001-vault-source.md` documenting the
  `node-vault` peer dependency choice and the Phase 2 vs Phase 3
  token-renewal boundary.

### Backwards compatibility

`${VAR}` Phase 1 syntax keeps working unchanged. `${secret:env:VAR}`
is semantically identical, so migration is a mechanical sed (no
breaking change for any existing consumer).

The `Config.snapshot()` signature is now `snapshot(options?)`;
calling it without arguments returns a masked tree (default
`{ includeSecrets: false }`). The previous behaviour — returning
the unmasked merged tree — is exposed via
`snapshot({ includeSecrets: true })` and still applies field-name
suffix masking. Consumers of the prior `snapshot()` who want the
exact previous output should reach for the structured-clone
fallback over their own state, or migrate their callsites.

### Refs

- ADR-0002 §1 grammar, §2 SecretSource contract, §3 SecretRef +
  caching, §4 loader integration, §5 error reasons, §6 VaultSource.
- per-binding `adr/0001-vault-source.md`.

## [0.3.1] — 2026-04-27

First stable public release on npmjs.org. Cumulative changes since 0.3.0:

- Translate inline comments and JSDoc to English across `src/` and `tests/` (rc.2).
- Verified end-to-end on the npmjs.org publish pipeline (rc.1).

Non-functional relative to 0.3.0 — public API, runtime behaviour, and type
signatures unchanged. The corresponding documentation site
(config.dagstack.dev) is also English-first.

## [0.3.1-rc.2] — 2026-04-26

Translate Russian inline comments and JSDoc to English across `src/` and `tests/`.
Non-functional change — public API, runtime behaviour, and type signatures unchanged.
Motivation: lower the barrier for international adopters (Russian comments were
visible in IDE hover via `dist/*.d.ts` and on the github mirror).

## [0.3.1-rc.1] — 2026-04-25

First public-publish release candidate. Tests the npmjs.org publish pipeline.

## [0.3.0] — 2026-04-23

Release tracking config-spec ADR v2.2 (pre-release quality hardening).
No breaking API changes; several observable behaviour changes.

### New

- **`isSecretField(name)` + `maskValue(name, value)` + `MASKED_PLACEHOLDER`** —
  implement ADR v2.2 §6: source-of-truth suffix / prefix / exact patterns
  from `_meta/secret_patterns.yaml`. Exported from `@dagstack/config`.

### Observable behaviour changes

- **`ConfigError.path` for array indices** (§4.2, §4.5): nested validation
  in an array element returns `database.servers[1].port` instead of
  `database.servers.1.port`. Round-trip invariant with `has()` / `get()`.
- **Secret masking in `ConfigError.details`** (§6): on `invalid_type` with
  a native scalar in a secret field, the value is replaced with `[MASKED]`.

### Conformance

- Submodule spec: `8cf2715` → `7ff2707` (ADR v2.2 merge).
- Load-level fixtures pass: `ijson_safe_boundary`, `yaml_1_2_bool_literals`
  (yaml package 2.x — YAML 1.2 by default), `getter_raw_vs_section_view`.
- Getter-level fixtures skipped; covered by unit tests in
  `tests/v2_2_hardening.test.ts` (20 tests).

## [0.2.0] — 2026-04-23

Release tracking config-spec ADR v2.1 (cross-binding conformance tightening).
Brings the TS binding into line with the spec on §4.4 / §4.5. The binding is
not published to npm — breaking change without shims.

### Breaking changes

- **`getSection`: env-string coercion** (ADR v2.1 §4.4). A new walker
  `src/section-coerce.ts` traverses the merged subtree using the zod schema
  via `_def.typeName` introspection (ZodObject / ZodNumber / ZodBoolean /
  ZodOptional / ZodDefault / ZodNullable / ZodArray) and converts
  env-substituted strings to `number` / `boolean` per
  `_meta/coercion.yaml` regexes **before** `schema.safeParse`.

  Result: `port: "${DB_PORT:-5432}"` in YAML with a
  `z.number().int()` field in the schema now parses correctly (zod
  previously rejected the string `"5432"` with `invalid_type`).

- **`getSection`: reverse-coerce rejection** (ADR v2.1 §4.4 M1). A native
  `number` / `bigint` / `boolean` in a `z.string()` field → `ConfigError(TYPE_MISMATCH)`
  with the full dot-notation path `section.field` (§4.5). Guards against silent
  `dimension: 768` → `"768"`. Previously this scenario produced
  `VALIDATION_FAILED`.

- **`getSection`: path preservation** (ADR v2.1 §4.5). For nested
  validation failures, `error.path` now concatenates the section prefix with
  zod's `issue.path`: `database.pool_size` instead of just `database`.

### Conformance

- Submodule spec: `09badaf` → `8cf2715` (ADR v2.1 merge).
- The `conformance` runner skips fixtures tagged `runner_extension_required`
  (v2.1 introduced 3 fixtures for getter/getSection level — runner v1.0
  models load level only). The binding covers these scenarios via native
  unit tests in `tests/section-coerce.test.ts` (9 tests).

## [Unreleased]

## [0.1.0] — 2026-04-23

First public release — TypeScript / Node binding of
[`dagstack/config-spec`](https://github.com/dagstack/config-spec) v2.1.
Byte-identical parity with
[`config-go`](https://github.com/dagstack/config-go) v0.1.0 and
[`config-python`](https://github.com/dagstack/config-python) v0.2.0
across the 8 spec conformance fixtures.

### Highlights

- YAML and JSON sources with env interpolation (`${VAR}`, `${VAR:-default}`,
  `$$` escape, UPPERCASE-ASCII names); interpolation runs before
  parsing, so `${PORT}` correctly appears in non-string positions in YAML.
- Deep-merge of layers: `app-config.yaml` → `app-config.local.yaml` →
  `app-config.${DAGSTACK_ENV}.yaml`; objects merge recursively, arrays
  are atomic-replaced, the result is immutable.
- `Config` class: `load(path, options)` auto-discovers layers,
  `loadFrom(sources)` takes an explicit order; strict getters per ADR v2.1 §4.3;
  `getSection(path, zodSchema)` for typed subsections via zod.
- Canonical JSON (a subset of RFC 8785 + `_meta/canonical_json.yaml`)
  for byte-identical serialization between bindings; whole-number
  floats emit integer form (`100.0` → `"100"`, `-0.0` → `"0"`).
- Three sources: `YamlFileSource`, `JsonFileSource`, `InMemorySource`.
- **168 unit tests + 8 conformance fixtures — all green**, ~98%
  coverage. Node 20 / 22, TypeScript strict + `exactOptionalPropertyTypes`.
- Minimum Node version is 18 (`engines.node` in `package.json`).

### Known limitations

- `Watcher` / `onChange` / `Close` are interfaces planned for Phase 2;
  currently not implemented (in v0.1 the config is immutable after `load`).
- The `ConfigSource.interpolate` flag is reserved for Phase 2 custom
  sources; the built-in sources interpolate inside `load()` themselves.
- Cross-binding float-format divergence (JS `1e20 → "100000000000000000000"`,
  Python `1e20 → "1e+20"`) — follow-up at the `dagstack/config-spec` level;
  extreme floats are intentionally excluded from the conformance fixtures.

### Contents

- **Phase A** (skeleton): `package.json`, `tsconfig.json`, `vitest`, `eslint` (flat), `Makefile`, CI on `dagstack-runner`.
- **Spec submodule** pointing at [`dagstack/config-spec`](https://github.com/dagstack/config-spec).
- **Phase B** (core primitives) — 5 modules per ADR-0001 §2-4 + `spec/_meta/*.yaml`:
  - `errors.ts` — `ConfigError` (extends `Error`), `ConfigErrorReason` enum (7 values from `_meta/error_reasons.yaml`), `isConfigError` type guard.
  - `canonical-json.ts` — `canonicalize()` per `_meta/canonical_json.yaml` (a subset of RFC 8785): keys sorted by UTF-8 code-point, minimal string escaping, safe-range integers `±(2^53 − 1)`, `-0.0 → 0.0`, NaN/Infinity rejected, no trailing newline.
  - `interpolation.ts` — `interpolate()`: a scanner-state parser for `${VAR}` / `${VAR:-default}` / `$$`, POSIX semantics for empty env variables, explicit rejection of nested `${${...}}`.
  - `merge.ts` — `deepMerge()` / `deepMergeAll()`: objects merge recursively, arrays are atomic-replaced, the result is immutable.
  - `paths.ts` — `parsePath()` / `getByPath()` / `hasPath()`: dot-notation `a.b[0].c[*]`, backslash-escape `.` in keys.
- **124 unit tests** (11 errors + 27 canonical-json + 33 interpolation + 23 merge + 29 paths + 1 smoke), coverage thresholds 80/75/80/80. Cross-binding float divergence (JS vs Python exponents) is locked down by a regression-guard test.
- **Phase C** (sources + Config API) — 3 modules and the `Config` class per ADR-0001 §4 + §8, on v2.1 semantics from the start:
  - `sources.ts` — `ConfigSource` interface; `YamlFileSource` / `JsonFileSource` (env interpolation before parsing + whole-number-float → integer normalize for parity with config-python's `_normalize_numbers`); `InMemorySource` for tests and programmatic init.
  - `config.ts` — `Config.load(path, options)` with auto-discovery of `<path>.local.yaml` and `<path>.${DAGSTACK_ENV}.yaml`; `Config.loadFrom(sources)` with deep-merge.
  - Strict getters per ADR v2.1 §4.3:
    - `getString` — does **not** coerce number/bool/null/object to string.
    - `getInt` — accepts whole-number floats inside the i-JSON safe range (`±(2^53 − 1)`).
    - `getBool` — recognizes `true|false|yes|no|1|0` case-insensitively.
    - `getNumber` — accepts int/float/numeric string (bool is rejected).
  - `getSection(path, zodSchema)` — typed subsection via zod.
  - `snapshot()` — deep copy of the merged tree; `sourceIds()` — list of source identifiers for diagnostics.
- **Phase D** (conformance runner) — `tests/conformance.test.ts` runs all fixtures from `spec/conformance/manifest.yaml` (version 1.0): on the happy path canonical JSON is compared byte-by-byte against `expected/*.json`, on the error path `reason` + `path` are checked. A soft skip applies if the submodule is not initialized.
- **Submodule `spec/`** — bumped to `09badaf` (ADR v2.1 with 4 wire clarifications + fixtures `whole_number_floats` / `null_parsing`).
- **168 unit tests + 8 conformance fixtures** (11 errors + 27 canonical-json + 33 interpolation + 23 merge + 29 paths + 16 sources + 28 config + 1 smoke + 9 conformance), ~98% coverage. Node 20/22, TypeScript strict + `exactOptionalPropertyTypes`.

[Unreleased]: https://github.com/dagstack/config-typescript/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/dagstack/config-typescript/releases/tag/v0.4.0
[0.3.1]: https://github.com/dagstack/config-typescript/releases/tag/v0.3.1
[0.3.0]: https://github.com/dagstack/config-typescript/releases/tag/v0.3.0
[0.2.0]: https://github.com/dagstack/config-typescript/releases/tag/v0.2.0
[0.1.0]: https://github.com/dagstack/config-typescript/releases/tag/v0.1.0
