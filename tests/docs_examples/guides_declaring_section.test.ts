// Auto-tests for `config-docs/site/docs/guides/declaring-section.mdx`
// (TypeScript snippets).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { Config } from "../../src/index.js";

// Standard DatabaseConfig and CacheConfig schemas — used in several doc
// snippets. Hoisted to module scope so we do not repeat them in each `it`.
const DatabaseConfig = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535).default(5432),
  name: z.string(),
  user: z.string(),
  password: z.string().min(1),
  pool_size: z.number().int().min(1).max(1000).default(20),
  ssl: z.boolean().default(false),
});

const CacheConfig = z.object({
  url: z.string(),
  ttl_min: z.number().int().default(15),
});

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-ts-docs-declaring-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeFullConfig(): Promise<string> {
  const yamlPath = join(workDir, "app-config.yaml");
  await writeFile(
    yamlPath,
    `database:
  host: localhost
  port: 5432
  name: orders
  user: app
  password: test-pw
  pool_size: 20

cache:
  url: redis://localhost:6379/0
  ttl_min: 15
`,
  );
  return yamlPath;
}

// ── Step 3. Read the section ────────────────────────────────────────

describe("guides/declaring-section.mdx — Step 3. Read the section (TypeScript)", () => {
  it("snippet: getSection returns a validated object", async () => {
    const yamlPath = await writeFullConfig();

    // --- snippet start -----------------------------------------------
    // import { Config } from "@dagstack/config";

    const config = await Config.load(yamlPath, { env: {} });
    const dbCfg = config.getSection("database", DatabaseConfig);
    // dbCfg is a value of z.infer<typeof DatabaseConfig>, already validated.
    // --- snippet end -------------------------------------------------

    expect(dbCfg.host).toBe("localhost");
    expect(dbCfg.pool_size).toBe(20);
    expect(dbCfg.ssl).toBe(false); // default from the schema
  });
});

// ── Step 4. Isolation ───────────────────────────────────────────────

describe("guides/declaring-section.mdx — Step 4. Isolation (TypeScript)", () => {
  it("snippet: a correct and an incorrect section read the same way", async () => {
    const yamlPath = await writeFullConfig();
    const config = await Config.load(yamlPath, { env: {} });

    // --- snippet start -----------------------------------------------
    // Correct — in the database service:
    const dbCfg = config.getSection("database", DatabaseConfig);

    // Incorrect — in the database service we read someone else's section:
    const cacheCfg = config.getSection("cache", CacheConfig);
    // The database service now depends on the cache structure.
    // --- snippet end -------------------------------------------------

    // Both calls work — the documentation only warns against cross-section
    // reads; it does not forbid them at the API level.
    expect(dbCfg.host).toBe("localhost");
    expect(cacheCfg.url).toBe("redis://localhost:6379/0");
  });
});

// ── Step 5. Defaults in the schema ──────────────────────────────────

describe("guides/declaring-section.mdx — Step 5. Defaults in the schema (TypeScript)", () => {
  it("snippet: defaults fill in when optional fields are absent", async () => {
    const yamlPath = join(workDir, "app-config.yaml");
    // The YAML contains only required fields.
    await writeFile(
      yamlPath,
      `database:
  host: localhost
  user: app
  password: pw
  name: test
`,
    );

    // --- snippet start (defaults-in-schema) -------------------------
    const DatabaseConfigWithDefaults = z.object({
      host: z.string(), // required
      user: z.string(), // required
      password: z.string(), // required
      port: z.number().int().default(5432), // schema default
      pool_size: z.number().int().default(20), // schema default
      ssl: z.boolean().default(false), // schema default
    });
    // --- snippet end ------------------------------------------------

    // The doc snippet does not mention `name`, but the test needs one —
    // extend with a separate schema.
    const DatabaseConfigWithName = DatabaseConfigWithDefaults.extend({
      name: z.string(),
    });

    const config = await Config.load(yamlPath, { env: {} });
    const db = config.getSection("database", DatabaseConfigWithName);

    // Defaults kicked in:
    expect(db.port).toBe(5432);
    expect(db.pool_size).toBe(20);
    expect(db.ssl).toBe(false);
  });
});
