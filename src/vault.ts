// Pilot HashiCorp Vault SecretSource adapter (ADR-0002 §6).
//
// Optional dependency: install `node-vault` alongside `@dagstack/config`
// to use this module. Without `node-vault`, importing throws an
// actionable error pointing at the install command.
//
// Phase 2 scope (ADR-0002 §6.1 / §6.2):
//
// - KV v2 only. KV v1 ships in Phase 3 if any operator requests it.
// - Token auth (mandatory) + AppRole auth (mandatory). Kubernetes
//   ServiceAccount auth (optional) — included as `KubernetesAuth`.
// - Namespace support (Vault Enterprise) — pass at construction time.
// - `?version=N` query — read a specific KV v2 version.
// - `#field` projection — pluck a sub-key from the JSON-typed secret.
//
// Token self-renewal lands alongside the Phase 3 rotation hook —
// scheduling lives in the same place as `Config.refreshSecrets()`.

import { ConfigError, ConfigErrorReason } from "./errors.js";
import type { ResolveContext, SecretSource, SecretValue } from "./secrets.js";

// node-vault has no public type for the client; the package's `index.d.ts`
// exports a generic interface but minds the per-method shape elsewhere.
// Type the import as `any` to keep this module's API surface stable
// independent of the upstream typing surface; we narrow on the call sites.

interface VaultClient {
  token?: string;
  read: (path: string) => Promise<unknown>;
  approleLogin: (opts: {
    role_id: string;
    secret_id: string;
    mount_point?: string;
  }) => Promise<unknown>;
  kubernetesLogin: (opts: { role: string; jwt: string; mount_point?: string }) => Promise<unknown>;
}

interface NodeVaultModule {
  default?: (opts: { apiVersion?: string; endpoint: string; namespace?: string }) => VaultClient;
}

let nodeVaultModule: NodeVaultModule | undefined;

/** Lazy-load `node-vault`; throws an actionable error if not installed. */
async function loadNodeVault(): Promise<NodeVaultModule> {
  if (nodeVaultModule !== undefined) return nodeVaultModule;
  try {
    nodeVaultModule = await import("node-vault");
    return nodeVaultModule;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      "VaultSource requires `node-vault` (peer dependency). Install with: npm install node-vault. " +
        `Underlying error: ${detail}`,
    );
  }
}

// ── Auth descriptors ──────────────────────────────────────────────────

/** Direct Vault token. Simplest case; covers any deployment that
 * already injects a token via init-container or operator action. */
export interface TokenAuth {
  readonly kind: "token";
  readonly token: string;
}

/** AppRole authentication — production CI/CD pipeline default. */
export interface AppRoleAuth {
  readonly kind: "approle";
  readonly roleId: string;
  readonly secretId: string;
  readonly mountPoint?: string;
}

/** Kubernetes ServiceAccount authentication. Reads the SA JWT from
 * the standard projected-token path; one Vault `auth/kubernetes/login`
 * round-trip per VaultSource lifetime (no in-flight renewal in Phase 2). */
export interface KubernetesAuth {
  readonly kind: "kubernetes";
  readonly role: string;
  readonly jwtPath?: string;
  readonly mountPoint?: string;
}

/** Discriminated union of supported auth methods. New auth methods
 * (AWS IAM, JWT/OIDC, TLS client certificate) land per operator demand
 * in Phase 3. */
export type VaultAuth = TokenAuth | AppRoleAuth | KubernetesAuth;

// ── VaultSource ───────────────────────────────────────────────────────

/** Construction options for VaultSource. */
export interface VaultSourceOptions {
  readonly addr: string;
  readonly auth: VaultAuth;
  readonly namespace?: string;
}

/**
 * SecretSource for HashiCorp Vault KV v2 (ADR-0002 §6).
 *
 * The `scheme` is hard-coded to `"vault"`. Operators wanting to register
 * two Vault clusters use a custom subclass with overridden `scheme`
 * (`vault-prod` / `vault-dr`) — schemes are an operator-extensible
 * space per ADR-0002 §Open-questions 1.
 *
 * Path layout: the user-visible path is what `vault kv get` accepts
 * (e.g. `secret/dagstack/prod/openai`). The first segment is the KV v2
 * mount point (default Vault setup uses `secret`); the remainder is the
 * logical key path. The Vault HTTP API expects `<mount>/data/<path>` —
 * the adapter rewrites it internally.
 *
 * Path also supports the optional `?version=N` query (read a specific
 * KV v2 version) and the `#field` projection (pluck a sub-key from a
 * multi-key secret) per ADR-0002 §6.3.
 */
export class VaultSource implements SecretSource {
  readonly scheme = "vault";
  readonly id: string;
  private readonly options: VaultSourceOptions;
  private client: VaultClient | undefined;

  constructor(options: VaultSourceOptions) {
    this.options = options;
    this.id =
      `vault:${options.addr}` + (options.namespace ? `?namespace=${options.namespace}` : "");
  }

  private async ensureAuthenticated(): Promise<VaultClient> {
    if (this.client !== undefined) return this.client;

    const mod = await loadNodeVault();
    if (mod.default === undefined) {
      throw new Error("node-vault module did not expose a default export — incompatible version?");
    }
    const client = mod.default({
      apiVersion: "v1",
      endpoint: this.options.addr,
      ...(this.options.namespace !== undefined ? { namespace: this.options.namespace } : {}),
    });

    const auth = this.options.auth;
    if (auth.kind === "token") {
      client.token = auth.token;
    } else if (auth.kind === "approle") {
      try {
        const resp = (await client.approleLogin({
          role_id: auth.roleId,
          secret_id: auth.secretId,
          mount_point: auth.mountPoint ?? "approle",
        })) as { auth?: { client_token?: string } };
        const token = resp.auth?.client_token;
        if (token === undefined) {
          throw new ConfigError({
            path: "",
            reason: ConfigErrorReason.SECRET_BACKEND_UNAVAILABLE,
            details: "Vault AppRole login returned no client_token",
            sourceId: this.id,
          });
        }
        client.token = token;
      } catch (err) {
        if (err instanceof ConfigError) throw err;
        throw this.translateAuthError("AppRole", err);
      }
    } else {
      // Kubernetes — read the projected SA JWT from the pod filesystem.
      const fs = await import("node:fs/promises");
      const jwtPath = auth.jwtPath ?? "/var/run/secrets/kubernetes.io/serviceaccount/token";
      let jwt: string;
      try {
        jwt = (await fs.readFile(jwtPath, "utf8")).trim();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new ConfigError({
          path: "",
          reason: ConfigErrorReason.SECRET_BACKEND_UNAVAILABLE,
          details:
            `cannot read Kubernetes ServiceAccount token at ${JSON.stringify(jwtPath)}: ${detail} ` +
            "(running outside a pod? misconfigured projected token?)",
          sourceId: this.id,
        });
      }
      try {
        const resp = (await client.kubernetesLogin({
          role: auth.role,
          jwt,
          mount_point: auth.mountPoint ?? "kubernetes",
        })) as { auth?: { client_token?: string } };
        const token = resp.auth?.client_token;
        if (token === undefined) {
          throw new ConfigError({
            path: "",
            reason: ConfigErrorReason.SECRET_BACKEND_UNAVAILABLE,
            details: "Vault Kubernetes login returned no client_token",
            sourceId: this.id,
          });
        }
        client.token = token;
      } catch (err) {
        if (err instanceof ConfigError) throw err;
        throw this.translateAuthError("Kubernetes", err);
      }
    }

    this.client = client;
    return client;
  }

  private translateAuthError(method: string, err: unknown): ConfigError {
    const detail = err instanceof Error ? err.message : String(err);
    // node-vault's ApiResponseError carries response.statusCode.
    const statusCode = (err as { response?: { statusCode?: number } }).response?.statusCode;
    if (statusCode === 403) {
      return new ConfigError({
        path: "",
        reason: ConfigErrorReason.SECRET_PERMISSION_DENIED,
        details: `Vault ${method} login rejected: ${detail}`,
        sourceId: this.id,
      });
    }
    return new ConfigError({
      path: "",
      reason: ConfigErrorReason.SECRET_BACKEND_UNAVAILABLE,
      details: `Vault ${method} login failed: ${detail}`,
      sourceId: this.id,
    });
  }

  async resolve(path: string, _ctx: ResolveContext): Promise<SecretValue> {
    const { mountPoint, keyPath, version, field } = parseVaultPath(path);
    const client = await this.ensureAuthenticated();

    let vaultPath = `${mountPoint}/data/${keyPath}`;
    if (version !== undefined) {
      vaultPath += `?version=${version.toString()}`;
    }

    let response: unknown;
    try {
      response = await client.read(vaultPath);
    } catch (err) {
      throw this.translateReadError(`${mountPoint}/${keyPath}`, version, err);
    }

    const envelope = response as {
      data?: { data?: Record<string, unknown>; metadata?: { version?: number } };
    };
    const secretData = envelope.data?.data;
    if (secretData === undefined) {
      throw new ConfigError({
        path: "",
        reason: ConfigErrorReason.SECRET_BACKEND_UNAVAILABLE,
        details: `Vault response for ${mountPoint}/${keyPath} has unexpected envelope shape (missing 'data.data')`,
        sourceId: this.id,
      });
    }

    const keys = Object.keys(secretData);
    if (keys.length === 0) {
      throw new ConfigError({
        path: "",
        reason: ConfigErrorReason.SECRET_UNRESOLVED,
        details: `Vault ${mountPoint}/${keyPath} contains an empty secret`,
        sourceId: this.id,
      });
    }

    let value: unknown;
    if (field !== undefined) {
      if (!(field in secretData)) {
        const sortedKeys = [...keys].sort();
        throw new ConfigError({
          path: "",
          reason: ConfigErrorReason.SECRET_UNRESOLVED,
          details:
            `Vault ${mountPoint}/${keyPath} has no field ${JSON.stringify(field)} ` +
            `(available keys: ${JSON.stringify(sortedKeys)})`,
          sourceId: this.id,
        });
      }
      value = secretData[field];
    } else if (keys.length > 1) {
      // ADR-0002 §1.2 normative message — verbatim text required for
      // cross-binding parity.
      const sortedKeys = [...keys].sort();
      throw new ConfigError({
        path: "",
        reason: ConfigErrorReason.SECRET_UNRESOLVED,
        details:
          "reference resolved to object; specify a sub-key with '#field' " +
          `(available keys: ${JSON.stringify(sortedKeys)})`,
        sourceId: this.id,
      });
    } else {
      // Single-key envelope — unwrap. `keys[0]` is non-undefined
      // because we guarded `keys.length === 0` above; eslint accepts
      // `!` here since the guard is local and obvious.
      const [onlyKey] = keys;
      if (onlyKey !== undefined) {
        value = secretData[onlyKey];
      }
    }

    const stringValue = typeof value === "string" ? value : String(value);
    const versionStr =
      envelope.data?.metadata?.version !== undefined
        ? String(envelope.data.metadata.version)
        : undefined;
    const result: SecretValue = { value: stringValue, sourceId: this.id };
    if (versionStr !== undefined) {
      Object.assign(result, { version: versionStr });
    }
    return result;
  }

  private translateReadError(
    refPath: string,
    version: number | undefined,
    err: unknown,
  ): ConfigError {
    const detail = err instanceof Error ? err.message : String(err);
    const statusCode = (err as { response?: { statusCode?: number } }).response?.statusCode;
    const versionPart = version !== undefined ? ` version=${version.toString()}` : "";
    if (statusCode === 403) {
      return new ConfigError({
        path: "",
        reason: ConfigErrorReason.SECRET_PERMISSION_DENIED,
        details:
          `Vault read of ${refPath}${versionPart} failed: rejected (Forbidden: ${detail}); ` +
          "check the Vault policy attached to this token / role",
        sourceId: this.id,
      });
    }
    if (statusCode === 404) {
      return new ConfigError({
        path: "",
        reason: ConfigErrorReason.SECRET_UNRESOLVED,
        details: `Vault read of ${refPath}${versionPart} failed: not found (404: ${detail})`,
        sourceId: this.id,
      });
    }
    return new ConfigError({
      path: "",
      reason: ConfigErrorReason.SECRET_BACKEND_UNAVAILABLE,
      details: `Vault read of ${refPath}${versionPart} failed: ${detail}`,
      sourceId: this.id,
    });
  }

  // node-vault's HTTP pool is implicit (axios). The adapter has no
  // resources to free in Phase 2; close() is a no-op.
  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ── Path parser ────────────────────────────────────────────────────────

interface ParsedVaultPath {
  mountPoint: string;
  keyPath: string;
  version: number | undefined;
  field: string | undefined;
}

/**
 * Split `<mount>/<key>[?version=N][#field]` into components.
 *
 * Exposed for tests; not part of the public API.
 */
export function parseVaultPath(path: string): ParsedVaultPath {
  let remainder = path;
  let field: string | undefined;
  if (remainder.includes("#")) {
    const hashIdx = remainder.indexOf("#");
    field = remainder.slice(hashIdx + 1);
    remainder = remainder.slice(0, hashIdx);
  }

  let query = "";
  if (remainder.includes("?")) {
    const qIdx = remainder.indexOf("?");
    query = remainder.slice(qIdx + 1);
    remainder = remainder.slice(0, qIdx);
  }

  if (!remainder.includes("/")) {
    throw new ConfigError({
      path: "",
      reason: ConfigErrorReason.SECRET_UNRESOLVED,
      details:
        `Vault path ${JSON.stringify(path)} does not include a mount-point segment ` +
        "(expected '<mount>/<key-path>', e.g. 'secret/dagstack/db')",
    });
  }
  const slashIdx = remainder.indexOf("/");
  const mountPoint = remainder.slice(0, slashIdx);
  const keyPath = remainder.slice(slashIdx + 1);

  let version: number | undefined;
  if (query !== "") {
    for (const kv of query.split("&")) {
      const eqIdx = kv.indexOf("=");
      if (eqIdx < 0) {
        throw new ConfigError({
          path: "",
          reason: ConfigErrorReason.SECRET_UNRESOLVED,
          details: `Vault query parameter ${JSON.stringify(kv)} is missing '='`,
        });
      }
      const k = kv.slice(0, eqIdx);
      const v = kv.slice(eqIdx + 1);
      if (k === "version") {
        const parsed = Number.parseInt(v, 10);
        if (Number.isNaN(parsed)) {
          throw new ConfigError({
            path: "",
            reason: ConfigErrorReason.SECRET_UNRESOLVED,
            details:
              `Vault path ${JSON.stringify(path)} has invalid ?version= value ` +
              `${JSON.stringify(v)}: must be an integer`,
          });
        }
        version = parsed;
      } else {
        throw new ConfigError({
          path: "",
          reason: ConfigErrorReason.SECRET_UNRESOLVED,
          details:
            `Vault path ${JSON.stringify(path)} has unknown query parameter ${JSON.stringify(k)}; ` +
            "only 'version' is recognised in Phase 2",
        });
      }
    }
  }

  return { mountPoint, keyPath, version, field };
}
