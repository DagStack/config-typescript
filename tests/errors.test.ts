import { describe, expect, it } from "vitest";

import { ConfigError, ConfigErrorReason, isConfigError } from "../src/errors.js";

describe("ConfigErrorReason enum", () => {
  it("contains all 10 values from _meta/error_reasons.yaml v1.1", () => {
    const values = Object.values(ConfigErrorReason);
    expect(values).toHaveLength(10);
    expect(values).toEqual(
      expect.arrayContaining([
        // Phase 1 (ADR-0001 §4.5)
        "missing",
        "type_mismatch",
        "env_unresolved",
        "validation_failed",
        "parse_error",
        "source_unavailable",
        "reload_rejected",
        // Phase 2 (ADR-0002 §5)
        "secret_unresolved",
        "secret_backend_unavailable",
        "secret_permission_denied",
      ]),
    );
  });

  it("values are lowercase snake_case strings", () => {
    for (const v of Object.values(ConfigErrorReason)) {
      expect(v).toMatch(/^[a-z][a-z_]*$/);
    }
  });
});

describe("ConfigError", () => {
  it("stores path / reason / details / sourceId", () => {
    const err = new ConfigError({
      path: "database.host",
      reason: ConfigErrorReason.MISSING,
      details: "required key absent",
      sourceId: "yaml:app-config.yaml",
    });
    expect(err.path).toBe("database.host");
    expect(err.reason).toBe("missing");
    expect(err.details).toBe("required key absent");
    expect(err.sourceId).toBe("yaml:app-config.yaml");
  });

  it("omits sourceId when not provided (exactOptionalPropertyTypes)", () => {
    const err = new ConfigError({
      path: "",
      reason: ConfigErrorReason.PARSE_ERROR,
      details: "invalid YAML",
    });
    expect(err.sourceId).toBeUndefined();
    expect("sourceId" in err).toBe(false);
  });

  it("composes human-readable message", () => {
    const err = new ConfigError({
      path: "database.password",
      reason: ConfigErrorReason.ENV_UNRESOLVED,
      details: "DB_PASSWORD not set",
    });
    expect(err.message).toBe("env_unresolved at 'database.password': DB_PASSWORD not set");
  });

  it("handles empty path in message", () => {
    const err = new ConfigError({
      path: "",
      reason: ConfigErrorReason.PARSE_ERROR,
      details: "invalid YAML",
    });
    expect(err.message).toBe("parse_error: invalid YAML");
  });

  it("includes sourceId in message when present", () => {
    const err = new ConfigError({
      path: "cache.ttl_min",
      reason: ConfigErrorReason.TYPE_MISMATCH,
      details: "expected int, got string",
      sourceId: "yaml:app-config.yaml",
    });
    expect(err.message).toBe(
      "type_mismatch at 'cache.ttl_min': expected int, got string [yaml:app-config.yaml]",
    );
  });

  it("extends native Error", () => {
    const err = new ConfigError({
      path: "",
      reason: ConfigErrorReason.MISSING,
      details: "x",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ConfigError");
  });

  it("stack trace is populated", () => {
    const err = new ConfigError({
      path: "",
      reason: ConfigErrorReason.MISSING,
      details: "x",
    });
    expect(err.stack).toBeTruthy();
    expect(err.stack).toContain("ConfigError");
  });
});

describe("isConfigError type-guard", () => {
  it("returns true for ConfigError instances", () => {
    const err = new ConfigError({
      path: "",
      reason: ConfigErrorReason.MISSING,
      details: "x",
    });
    expect(isConfigError(err)).toBe(true);
  });

  it("returns false for plain Error, strings, nulls, objects", () => {
    expect(isConfigError(new Error("x"))).toBe(false);
    expect(isConfigError("x")).toBe(false);
    expect(isConfigError(null)).toBe(false);
    expect(isConfigError(undefined)).toBe(false);
    expect(isConfigError({ path: "", reason: "missing", details: "x" })).toBe(false);
  });
});
