// @dagstack/config — TypeScript binding for dagstack/config-spec.
//
// Phase B + C: public API — the Config class plus primitives.

export const VERSION = "0.4.0";

// Main Config API (ADR-0001 §4)
export { Config, type LoadOptions } from "./config.js";

// Sources (ADR-0001 §8)
export {
  YamlFileSource,
  JsonFileSource,
  InMemorySource,
  type ConfigSource,
  type FileSourceOptions,
} from "./sources.js";

// Errors (ADR-0001 §4.5)
export { ConfigError, ConfigErrorReason, isConfigError, type ConfigErrorInit } from "./errors.js";

// Canonical JSON (ADR-0001 §9.1.1, spec/_meta/canonical_json.yaml)
export { canonicalize, type JsonValue } from "./canonical-json.js";

// Env interpolation (ADR-0001 §2)
export { interpolate, type EnvMap } from "./interpolation.js";

// Deep merge (ADR-0001 §3)
export { deepMerge, deepMergeAll, type ConfigTree, type ConfigValue } from "./merge.js";

// Secret masking (ADR-0001 v2.2 §6)
export { isSecretField, maskValue, MASKED_PLACEHOLDER } from "./secrets-mask.js";

// Secret references and SecretSource adapters (ADR-0002 §2/§3/§4).
export {
  EnvSecretSource,
  isSecretRef,
  makeSecretRef,
  type AsyncSecretSource,
  type EnvLookup,
  type ResolveContext,
  type SecretRef,
  type SecretSource,
  type SecretValue,
} from "./secrets.js";

// VaultSource pilot adapter (ADR-0002 §6, this binding's ADR-0001).
// Imports `node-vault` lazily — the optional peer dependency is
// loaded only when VaultSource is constructed. Without `node-vault`,
// the constructor throws an actionable error.
export {
  VaultSource,
  type AppRoleAuth,
  type KubernetesAuth,
  type TokenAuth,
  type VaultAuth,
  type VaultSourceOptions,
} from "./vault.js";

// Path addressing (ADR-0001 §4.2)
export {
  parsePath,
  getByPath,
  hasPath,
  type PathSegment,
  type KeySegment,
  type IndexSegment,
} from "./paths.js";
