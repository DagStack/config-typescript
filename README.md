# @dagstack/config

TypeScript / Node.js binding for [dagstack/config-spec](https://github.com/dagstack/config-spec) — YAML configuration with env interpolation, deep-merge layering, zod-based typed sections, secret references with pluggable backends.

**Status:** Phase 1 (`0.3.x`) is published on npm. Phase 2 secrets (`0.4.x`) adds `${secret:...}` references with HashiCorp Vault as the pilot adapter (peer dependency on `node-vault`).

## Secrets (Phase 2 — `0.4.0+`)

Per [ADR-0002](https://github.com/dagstack/config-spec/blob/main/adr/0002-secret-references-and-sources.md), Phase 2 adds the `${secret:<scheme>:<path>}` interpolation token alongside Phase 1's `${VAR}`. Pluggable `SecretSource` adapters resolve the references at load time. Unlike the Python binding, TypeScript does not expose a lazy mode in Phase 2 — getters on `Config` are synchronous, so all resolution happens up-front in `loadFrom`.

The `env` scheme is auto-registered and behaves identically to Phase 1's `${VAR}`:

```yaml
# app-config.yaml
llm:
  api_key: ${secret:env:OPENAI_API_KEY} # ≡ ${OPENAI_API_KEY}
  fallback: ${secret:env:OPENAI_API_KEY:-sk-dev-placeholder}
```

The pilot HashiCorp Vault adapter ships in the same package; install `node-vault` as a peer:

```bash
npm install @dagstack/config node-vault
```

```typescript
import { Config, YamlFileSource, VaultSource } from "@dagstack/config";

const cfg = await Config.loadFrom([
  new YamlFileSource("app-config.yaml"),
  new VaultSource({
    addr: "https://vault.example.com",
    auth: { kind: "token", token: process.env.VAULT_TOKEN! },
    namespace: "dagstack/prod",
  }),
]);
const apiKey = cfg.getString("llm.api_key");
// ${secret:vault:secret/dagstack/prod/openai#api_key}
```

`?version=N` selects a specific KV v2 version; `#field` plucks a sub-key from a multi-key secret. `kind: "approle"` (AppRole) and `kind: "kubernetes"` (Kubernetes ServiceAccount) auth are supported alongside `kind: "token"` — see `adr/0001-vault-source.md` for details.

## Runtime API

- **`Config.refreshSecrets()`** — drops the cached resolved tree and re-resolves every `${secret:...}` reference against its registered `SecretSource`, then atomically swaps the internal reference. `SecretValue.expiresAt` is honoured at this call only — schedule `setInterval(() => cfg.refreshSecrets(), …)` to honour Vault TTL or rotation cadence. Manual rotation hook for Phase 2; push-based rotation is deferred to Phase 3.
- **`Config.snapshot({ includeSecrets: false })`** (default) — returns a deep-clone of the merged tree with every `SecretRef` placeholder masked to `[MASKED]` and every plain string under a secret-named key (`api_key`, `password`, …) also masked. No backend round-trip.
- **`Config.snapshot({ includeSecrets: true })`** — audit-mode opt-in: returns the resolved tree with field-name suffix masking still applied. Treat the result as sensitive.

## Roadmap

- **Phase 1 (`0.3.x`)** — base spec MVP: file sources, env interpolation, deep-merge layering, zod typed sections, canonical JSON.
- **Phase 2 (`0.4.x`)** — secret references + pluggable `SecretSource` adapters (per ADR-0002). VaultSource pilot.
- **Phase 3+** — push-based rotation events, AWS / GCP / K8s secret-manager adapters, watch + push-reload of file sources.

## Spec

The spec submodule lives in `spec/` (pointing to [`dagstack/config-spec`](https://github.com/dagstack/config-spec)). Normative decisions are recorded in `spec/adr/0001-yaml-configuration.md`.

## Local development

```bash
git clone --recurse-submodules git@github.com:dagstack/config-typescript.git
cd config-typescript
npm install

make test           # vitest run
make lint           # eslint .
make typecheck      # tsc --noEmit
make build          # tsc -b
```

Requirements: Node.js ≥20, TypeScript ≥5.5.

## Cross-language parity

This package passes the same golden fixtures as the reference binding [`dagstack/config-python`](https://github.com/dagstack/config-python). Byte-identical canonical JSON output is part of the spec's contract (ADR-0001 §9.1.1).

## Thread-safety

### Single-threaded by default

Node.js executes JavaScript on a single-threaded event loop. Once a `Config` instance is built by `Config.load(...)` or `Config.loadFrom(...)`, the merged tree is held as an immutable internal reference; `get(...)`, `getString(...)`, `getInt(...)`, `getNumber(...)`, `getBool(...)`, `getList(...)`, `getSection(...)` and `sourceIds()` are synchronous reads against that tree (`getSection(...)` additionally runs zod validation — see [Async usage](#async-usage)). A single `Config` instance can therefore be freely shared across all callbacks, timers, HTTP handlers and `async` chains served by the same event loop — there is no read/write race in the standard single-process model.

`sourceIds()` returns a `readonly string[]` whose contract is read-only; the binding does not freeze the underlying array, so callers must treat it as immutable (TypeScript enforces this at compile time).

### `worker_threads` caveat

If the application uses `worker_threads` (`new Worker(...)`), a `Config` instance built on the main thread is **not** automatically shared with the worker. Each `Worker` runs in a separate V8 isolate with its own heap, and only structured-cloneable values can cross the boundary via `postMessage(...)`; `Config` instances and the `ConfigSource` objects they hold are not designed to be transferred.

Two supported patterns:

- **Recommended — re-load per worker.** Each worker calls `await Config.load(path)` (or `loadFrom(...)`) on startup and re-reads the same YAML files from disk. The cost is a duplicate parse and a duplicate in-memory tree per worker; the benefit is full isolation, correct env interpolation in each worker's `process.env`, and per-worker subscriptions / future watchers (see [Roadmap](#roadmap)).
- **Alternative — snapshot via `postMessage`.** The main thread loads `Config` once and ships a deep-cloned snapshot to each worker, e.g. `worker.postMessage(config.snapshot())`. The receiving worker gets a structured-cloned plain object that is independent of the parent; it cannot subscribe to reloads or use the typed-section API (`getSection(...)` requires a live `Config`). Use this only for read-only fan-out where workers genuinely need an identical view at a single point in time.

### Reload semantics

The merged tree is built once at construction time and never mutated for ConfigSource-derived data. `Config.refreshSecrets()` re-resolves Phase 2 secret references in place: it builds a new resolved tree from the original sources and atomically swaps the internal reference. Concurrent readers on the same event loop are impossible by construction. A reader on another worker — if such a worker happens to share state through a user-supplied transport — will observe either the old or the new value, never a torn intermediate.

Push-capable sources (etcd, Consul, HTTP) and a `Watcher` / `OnChange` / `Close` surface are reserved for Phase 3+; subscriber callbacks will be dispatched on the event-loop microtask queue.

### Async usage

The public API is synchronous and does not return `Promise`s (except `Config.load(...)` / `Config.loadFrom(...)` themselves, which perform I/O). It is safe to call from any `async` function without `await`. On hot paths it is worth caching a `getSection(...)` result in a `const` to avoid re-walking the tree and re-running zod validation on every call.

## Licensing

Apache-2.0 (see [LICENSE](./LICENSE)).

## Related

- [`dagstack/config-spec`](https://github.com/dagstack/config-spec) — language-agnostic specification.
- [`dagstack/config-python`](https://github.com/dagstack/config-python) — reference binding (Python, Pydantic-based).
- [`dagstack/plugin-system-typescript`](https://github.com/dagstack/plugin-system-typescript) — neighboring TS binding (CI / tsconfig / emitter pattern).
