// Auto-tests for `config-docs/site/docs/concepts/layers.mdx`
// (TypeScript snippets).

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Config, YamlFileSource } from "../../src/index.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-ts-docs-layers-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── "Explicit list of layers" — loadFrom([YamlFileSource[]]) ───────

describe("concepts/layers.mdx — Explicit list of layers (TypeScript)", () => {
  it("snippet: order = priority, DAGSTACK_ENV is not applied", async () => {
    const cfgDir = join(workDir, "config");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(join(cfgDir, "base.yaml"), "database:\n  host: base-host\n  pool_size: 10\n");
    await writeFile(join(cfgDir, "integration-test.yaml"), "database:\n  pool_size: 3\n");
    await writeFile(join(cfgDir, "secrets-ci.yaml"), "database:\n  password: ci-secret\n");

    // --- snippet start -----------------------------------------------
    // import { Config, YamlFileSource } from "@dagstack/config";

    const config = await Config.loadFrom([
      new YamlFileSource(join(cfgDir, "base.yaml"), { env: {} }),
      new YamlFileSource(join(cfgDir, "integration-test.yaml"), { env: {} }),
      new YamlFileSource(join(cfgDir, "secrets-ci.yaml"), { env: {} }),
    ]);
    // The order defines priority; DAGSTACK_ENV is not applied.
    // --- snippet end -------------------------------------------------

    expect(config.getString("database.host")).toBe("base-host");
    expect(config.getInt("database.pool_size")).toBe(3); // overridden by integration-test
    expect(config.getString("database.password")).toBe("ci-secret"); // from secrets-ci
  });
});

// ── "How to inspect which layers were applied" — sourceIds() ───────

describe("concepts/layers.mdx — sourceIds() diagnostic (TypeScript)", () => {
  it("snippet: sourceIds() — list of ConfigSource ids", async () => {
    const yamlPath = join(workDir, "app-config.yaml");
    await writeFile(yamlPath, "only: me\n");

    // Disable the env layer (dagstackEnv: null) so sourceIds contains
    // only base.
    const config = await Config.load(yamlPath, { dagstackEnv: null, env: {} });

    // --- snippet start -----------------------------------------------
    // console.log(config.sourceIds());
    // → ["yaml:app-config.yaml", "yaml:app-config.local.yaml",
    //    "yaml:app-config.production.yaml"]
    // --- snippet end -------------------------------------------------

    // In TypeScript sourceIds() is a method (parity with docs, which show
    // `config.sourceIds()`). This differs from the Python binding, where
    // source_ids is a property (a docs drift on the Python side).
    const ids = config.sourceIds();
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^yaml:/);
    expect(ids[0]).toContain("app-config.yaml");
  });
});
