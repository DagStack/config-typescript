// ConfigError + ConfigErrorReason enum.
//
// ADR-0001 §4.5 — structural error model:
//   { path: string, reason: ConfigErrorReason, details: string, sourceId?: string }
//
// The values of ConfigErrorReason are fixed in spec/_meta/error_reasons.yaml.
// Bindings MUST use identical string values — these strings surface in
// diagnostic channels and are compared in conformance fixtures.

export const ConfigErrorReason = {
  MISSING: "missing",
  TYPE_MISMATCH: "type_mismatch",
  ENV_UNRESOLVED: "env_unresolved",
  VALIDATION_FAILED: "validation_failed",
  PARSE_ERROR: "parse_error",
  SOURCE_UNAVAILABLE: "source_unavailable",
  RELOAD_REJECTED: "reload_rejected",
  // ADR-0002 (Phase 2 — secret resolution errors).
  SECRET_UNRESOLVED: "secret_unresolved",
  SECRET_BACKEND_UNAVAILABLE: "secret_backend_unavailable",
  SECRET_PERMISSION_DENIED: "secret_permission_denied",
} as const;

export type ConfigErrorReason = (typeof ConfigErrorReason)[keyof typeof ConfigErrorReason];

export interface ConfigErrorInit {
  path: string;
  reason: ConfigErrorReason;
  details: string;
  sourceId?: string;
}

export class ConfigError extends Error {
  readonly path: string;
  readonly reason: ConfigErrorReason;
  readonly details: string;
  // `declare` is type-level only and does not create an own property with
  // `undefined` on the instance. We assign only when a value is provided, so
  // `"sourceId" in err` is false when sourceId was not passed (symmetric with
  // the Pydantic pattern in config-python: unset != None).
  declare readonly sourceId?: string;

  constructor(init: ConfigErrorInit) {
    const location = init.path === "" ? "" : ` at '${init.path}'`;
    const source = init.sourceId === undefined ? "" : ` [${init.sourceId}]`;
    super(`${init.reason}${location}: ${init.details}${source}`);
    this.name = "ConfigError";
    this.path = init.path;
    this.reason = init.reason;
    this.details = init.details;
    if (init.sourceId !== undefined) {
      (this as { sourceId: string }).sourceId = init.sourceId;
    }
  }
}

// Type guard for convenient checks in catch blocks.
export function isConfigError(value: unknown): value is ConfigError {
  return value instanceof ConfigError;
}
