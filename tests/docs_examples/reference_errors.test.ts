// Auto-tests for `config-docs/site/docs/reference/errors.mdx`
// (TypeScript snippets).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ConfigError } from "../../src/index.js";
import { Config, ConfigErrorReason, InMemorySource, isConfigError } from "../../src/index.js";

// Shared mini-config used by the negative tests.
async function sampleConfig(): Promise<Config> {
  return Config.loadFrom([
    new InMemorySource({
      database: {
        host: "localhost",
        pool_size: "twenty", // invalid for getInt
        password: "", // invalid for zod min(1)
      },
    }),
  ]);
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-ts-docs-errors-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── `missing` ────────────────────────────────────────────────────────

describe("reference/errors.mdx — missing (TypeScript)", () => {
  it("snippet: getString on a non-existent path → missing", async () => {
    const config = await sampleConfig();

    let caught: unknown = undefined;
    try {
      // --- snippet start ---------------------------------------------
      config.getString("nonexistent.path");
      // Throws ConfigError {
      //   path: "nonexistent.path",
      //   reason: "missing",
      //   details: "Key 'nonexistent.path' not found in config and no default provided",
      // }
      // --- snippet end -----------------------------------------------
    } catch (exc) {
      caught = exc;
    }
    expect(isConfigError(caught)).toBe(true);
    const err = caught as ConfigError;
    expect(err.reason).toBe(ConfigErrorReason.MISSING);
    // The TS binding returns the full dot-notation path (parity with docs).
    expect(err.path).toBe("nonexistent.path");
  });
});

// ── `type_mismatch` ──────────────────────────────────────────────────

describe("reference/errors.mdx — type_mismatch (TypeScript)", () => {
  it("snippet: getInt on a string value → type_mismatch", async () => {
    const config = await sampleConfig();

    let caught: unknown = undefined;
    try {
      // --- snippet start ---------------------------------------------
      // YAML: pool_size: "twenty"
      config.getInt("database.pool_size");
      // Throws ConfigError {
      //   path: "database.pool_size",
      //   reason: "type_mismatch",
      //   details: "Expected int, got string 'twenty' (does not match ^-?\\d+$)",
      // }
      // --- snippet end -----------------------------------------------
    } catch (exc) {
      caught = exc;
    }
    expect(isConfigError(caught)).toBe(true);
    const err = caught as ConfigError;
    expect(err.reason).toBe(ConfigErrorReason.TYPE_MISMATCH);
    expect(err.path).toBe("database.pool_size");
  });
});

// ── `env_unresolved` ─────────────────────────────────────────────────

describe("reference/errors.mdx — env_unresolved (TypeScript)", () => {
  it("snippet: ${DB_PASSWORD} without a default + missing env", async () => {
    const yamlPath = join(workDir, "app-config.yaml");
    await writeFile(yamlPath, 'database:\n  password: "${DB_PASSWORD}"\n');

    let caught: unknown = undefined;
    try {
      // env: {} — explicitly empty environment, DB_PASSWORD does not resolve.
      await Config.load(yamlPath, { env: {}, dagstackEnv: null });
    } catch (exc) {
      caught = exc;
    }
    expect(isConfigError(caught)).toBe(true);
    const err = caught as ConfigError;
    expect(err.reason).toBe(ConfigErrorReason.ENV_UNRESOLVED);
  });
});

// ── `validation_failed` ──────────────────────────────────────────────

describe("reference/errors.mdx — validation_failed (TypeScript)", () => {
  it("snippet: getSection failed on zod validation", async () => {
    // --- snippet start ------------------------------------------------
    const DatabaseConfig = z.object({
      host: z.string(),
      password: z.string().min(1),
    });
    // YAML: password: ""  (empty string)
    // --- snippet end --------------------------------------------------

    const config = await sampleConfig();

    let caught: unknown = undefined;
    try {
      config.getSection("database", DatabaseConfig);
    } catch (exc) {
      caught = exc;
    }
    expect(isConfigError(caught)).toBe(true);
    const err = caught as ConfigError;
    expect(err.reason).toBe(ConfigErrorReason.VALIDATION_FAILED);
  });
});

// ── `source_unavailable` ─────────────────────────────────────────────

describe("reference/errors.mdx — source_unavailable (TypeScript)", () => {
  it("snippet: Config.load on a non-existent file", async () => {
    let caught: unknown = undefined;
    try {
      // --- snippet start ---------------------------------------------
      // File does not exist:
      await Config.load(join(workDir, "non-existent.yaml"), {
        env: {},
        dagstackEnv: null,
      });
      // Throws ConfigError {
      //   path: "",
      //   reason: "source_unavailable",
      //   details: "cannot read non-existent.yaml: ENOENT: no such file or directory",
      //   sourceId: "yaml:non-existent.yaml",
      // }
      // --- snippet end -----------------------------------------------
    } catch (exc) {
      caught = exc;
    }
    expect(isConfigError(caught)).toBe(true);
    const err = caught as ConfigError;
    expect(err.reason).toBe(ConfigErrorReason.SOURCE_UNAVAILABLE);
  });
});

// ── Handler snippet with try/catch + switch ─────────────────────────

describe("reference/errors.mdx — handler switch (TypeScript)", () => {
  it("snippet: try/catch + switch on reason", async () => {
    const config = await sampleConfig();

    // --- snippet start (simplified) -------------------------------------
    let handledReason: ConfigErrorReason | null = null;
    try {
      config.getString("nonexistent");
    } catch (exc) {
      if (isConfigError(exc)) {
        switch (exc.reason) {
          case ConfigErrorReason.MISSING:
            handledReason = exc.reason;
            break;
          case ConfigErrorReason.ENV_UNRESOLVED:
            handledReason = exc.reason;
            break;
          case ConfigErrorReason.VALIDATION_FAILED:
            handledReason = exc.reason;
            break;
        }
      }
    }
    // --- snippet end ----------------------------------------------------

    expect(handledReason).toBe(ConfigErrorReason.MISSING);
  });
});
