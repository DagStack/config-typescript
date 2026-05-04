# ADR-0001 (config-typescript): VaultSource — SDK choice and renewal strategy

- **Status:** accepted
- **Revision:** 1.0 (2026-05-03)
- **Date:** 2026-05-03
- **Architect review:** ai-systems-architect (proposed round 2026-05-03)
- **Related:** [config-spec ADR-0002 §6](https://github.com/dagstack/config-spec/blob/main/adr/0002-secret-references-and-sources.md#6-pilot-adapter--vaultsource-hashicorp-vault-kv-v2),
  [node-vault upstream](https://github.com/nodevault/node-vault).

## Context

ADR-0002 in `dagstack/config-spec` mandates a HashiCorp Vault adapter
for the Phase 2 SecretSource roll-out across the three bindings
(`config-python`, `config-typescript`, `config-go`). The cross-binding
spec leaves SDK choice, packaging strategy, and token renewal to
each binding.

This ADR records the choices for the TypeScript binding.

## Decision

### 1. SDK — `node-vault@^0.10`

`node-vault` is the most-downloaded Vault client for Node.js and ships
with TypeScript declarations on DefinitelyTyped. Considered alternatives:

- **`@hashicorp/vault-client-typescript`** — the official client.
  Newer, fewer downloads as of 2026-05; tracking it for a possible
  future swap once it stabilises and tooling around it improves.
  No blocker today; swap will land as a separate PR with a release note.
- **Hand-rolled `fetch` against the HTTP API** — feasible for the narrow
  KV v2 path, but loses the auth-method helpers (`approleLogin`,
  `kubernetesLogin`) and shifts maintenance burden onto the binding.

Pin `^0.10` — major-0 means breaking changes can land on minors per
semver convention, so we lock the minor explicitly when bumping.

### 2. Packaging — peer dependency (optional)

`package.json`:

```json
"peerDependenciesMeta": {
  "node-vault": { "optional": true }
},
"optionalDependencies": {
  "node-vault": "^0.12.0"
}
```

Consumers using only file sources install with
`npm install @dagstack/config` and pay no dependency cost. Consumers
wanting the Vault adapter install with
`npm install @dagstack/config node-vault`.

The Vault module lazy-imports `node-vault`. Without the peer install,
the first reference throws an actionable error with the install command.

### 3. Async-first

TypeScript bindings expose every SecretSource via `Promise<SecretValue>`.
There is no sync/async split — `Promise<T>` is the universal flavour.
Eager resolution at `Config.loadFrom` (per the binding's design choice;
see ADR-0001 v2.1 in `dagstack/config-typescript`) means Vault
round-trips happen at load time, not at first request.

### 4. Token renewal — Phase 2 boundary

Vault tokens carry a TTL. `VaultSource` does **not** spawn a renewal
background task in Phase 2 — token renewal lives in the same Phase 3
PR as `Config.refreshSecrets()` and the rotation hook (consistent
across bindings).

Phase 2 patterns operators can use:

1. **Long TTL + restart** — Vault tokens issued with a TTL longer
   than the application's expected uptime; renewal handled by an
   init-container or sidecar at SIGTERM.
2. **AppRole** — `secret_id` is a credential, not a session;
   `VaultSource` performs `approle/login` at first read; the resulting
   token has a TTL the operator controls through Vault's role
   configuration. Restart re-logs-in.
3. **Kubernetes ServiceAccount** — kubelet renews the projected SA JWT
   on a ~60-minute cadence; re-login is cheap.

### 5. Test strategy

Phase 2 ships:

- **Unit tests** with `vi.mock("node-vault")` — 16 tests covering path
  parsing, KV v2 envelope handling, `#field` projection, `?version=`
  query, auth dispatch (Token + AppRole), 403 → PERMISSION_DENIED,
  end-to-end via `Config.loadFrom`.

Deferred to a follow-up PR alongside the conformance fixtures from
config-spec issue #18 slice 3:

- **Integration tests** with `testcontainers-node` against `vault:1.15`
  in dev mode, with a seed script populating known KV v2 paths.

This split keeps the Phase 2 PR fast (no Docker dependency in the unit
suite) and lets us land the cross-binding fixture set in lockstep with
Python and Go bindings.

## Consequences

### Positive

- Zero dependency cost for consumers using only file sources.
- First-class auth coverage — Token, AppRole, Kubernetes ServiceAccount.
- Maintained upstream — `node-vault` has DefinitelyTyped types and is
  the de facto Node.js Vault client.
- Lazy import + actionable error on missing peer install.

### Negative

- `node-vault` types are external (`@types/node-vault` ships via
  `DefinitelyTyped`); a future major of `node-vault` may break the
  type contract and require coordinated upgrade. Mitigated by the
  generic `client.read()` shape we exercise.
- No automatic renewal in Phase 2; operators rely on long TTLs or
  external renewal. Mitigated by AppRole + Kubernetes auth which
  produce operator-controlled-TTL tokens.

### Neutral

- zod schemas in `getSection` are unaffected — resolution happens
  before schema validation.

## Out of scope

- KV v1 (Phase 3 if any operator requests it).
- Dynamic secrets with leases (`database/creds/...`) — requires
  background-renewal infrastructure that lands with the rotation hook.
- Vault Agent integration / Banzai Vault wrappers — deployment-time
  concerns the operator runs alongside the application.
- Token revocation on `close()` — operators that want it call
  `client.tokenRevokeSelf()` themselves before close.
