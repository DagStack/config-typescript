// Auto-tests for `config-docs/site/docs/concepts/sources.mdx`
// (TypeScript snippets).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Config, InMemorySource, YamlFileSource } from "../../src/index.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-ts-docs-sources-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── "Explicit list of sources" — InMemorySource as a test override ──

describe("concepts/sources.mdx — loadFrom with YamlFileSource + InMemorySource", () => {
  it("snippet: test override via the in-memory layer", async () => {
    const yamlPath = join(workDir, "app-config.yaml");
    await writeFile(
      yamlPath,
      `database:
  host: "localhost"
  port: 5432
  name: "orders"
  user: "app"
  password: "test-pw"
  pool_size: 20
`,
    );

    // --- snippet start -----------------------------------------------
    // import { Config, YamlFileSource, InMemorySource } from "@dagstack/config";

    const config = await Config.loadFrom([
      new YamlFileSource(yamlPath, { env: {} }),
      new InMemorySource({ database: { pool_size: 5 } }),
    ]);
    // --- snippet end -------------------------------------------------

    // The argument order is the priority order: InMemorySource (last)
    // overrides YamlFileSource for any matching keys. Other YAML keys
    // remain in place.
    expect(config.getInt("database.pool_size")).toBe(5); // overridden
    expect(config.getString("database.host")).toBe("localhost"); // from YAML
    expect(config.getString("database.user")).toBe("app"); // from YAML
  });
});
