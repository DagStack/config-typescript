// Auto-tests for `config-docs/site/docs/guides/testing.mdx`
// (TypeScript snippets).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { Config, InMemorySource } from "../../src/index.js";

// DatabaseConfigSchema — the analogue from guides/declaring-section (TS
// snippet); in testing.mdx it is imported from src/database.
const DatabaseConfigSchema = z.object({
  host: z.string().refine((v) => v !== "0.0.0.0" && v !== "*", "host must be a concrete address"),
  port: z.number().int().min(1).max(65535).default(5432),
  name: z.string(),
  user: z.string(),
  password: z.string().min(1),
  pool_size: z.number().int().min(1).max(1000).default(20),
});

// DatabasePool — a minimal implementation (the docs import it from
// src/database). Only the size field is needed for the snippet test.
class DatabasePool {
  readonly size: number;
  constructor(cfg: z.infer<typeof DatabaseConfigSchema>) {
    this.size = cfg.pool_size;
  }
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-ts-docs-testing-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── "Unit tests — inline config via the in-memory source" ──────────

describe("guides/testing.mdx — Unit tests with InMemorySource (TypeScript)", () => {
  it("snippet: uses configured size", async () => {
    // --- snippet start -----------------------------------------------
    // import { describe, it, expect } from "vitest";
    // import { Config, InMemorySource } from "@dagstack/config";
    // import { DatabaseConfigSchema, DatabasePool } from "../src/database";

    const config = await Config.loadFrom([
      new InMemorySource({
        database: {
          host: "localhost",
          port: 5432,
          name: "test",
          user: "app",
          password: "test-pw",
          pool_size: 42,
        },
      }),
    ]);
    const pool = new DatabasePool(config.getSection("database", DatabaseConfigSchema));
    expect(pool.size).toBe(42);
    // --- snippet end -------------------------------------------------
  });

  it("snippet: rejects invalid host", async () => {
    // --- snippet start -----------------------------------------------
    const config = await Config.loadFrom([
      new InMemorySource({
        database: {
          host: "0.0.0.0",
          name: "test",
          user: "app",
          password: "pw",
        },
      }),
    ]);
    expect(() => config.getSection("database", DatabaseConfigSchema)).toThrow(
      /host must be a concrete/,
    );
    // --- snippet end -------------------------------------------------
  });
});

// ── "File-based test in a temp directory" — env interpolation ──────

describe("guides/testing.mdx — YamlFileSource in tmpdir (TypeScript)", () => {
  it("snippet: env interpolation", async () => {
    // --- snippet start -----------------------------------------------
    // import { test, expect } from "vitest";
    // import * as fs from "fs/promises";
    // import * as path from "path";
    // import * as os from "os";
    // import { Config } from "@dagstack/config";

    // (tmpdir and writeFile are reused via beforeEach)
    await writeFile(
      join(workDir, "app-config.yaml"),
      `database:
  host: "\${DB_HOST:-localhost}"
  password: "\${DB_PASSWORD}"
  name: "test_db"
  user: "app"
`,
    );

    // In the docs snippet it is `process.env.DB_PASSWORD = "test-pw"`. In
    // the test we isolate via options.env (the idiomatic way in vitest
    // without mutating the global process.env — the docs snippet
    // simplifies slightly, but the API is identical).
    const config = await Config.load(join(workDir, "app-config.yaml"), {
      env: { DB_PASSWORD: "test-pw" },
    });
    expect(config.getString("database.password")).toBe("test-pw");
    expect(config.getString("database.host")).toBe("localhost"); // default kicked in
    // --- snippet end -------------------------------------------------
  });
});

// ── "Integration tests with DAGSTACK_ENV" ──────────────────────────

describe("guides/testing.mdx — DAGSTACK_ENV integration (TypeScript)", () => {
  it("snippet: production layer overrides base", async () => {
    await writeFile(
      join(workDir, "app-config.yaml"),
      "database:\n  pool_size: 20\n  host: 'localhost'\n  name: 'test'\n  user: 'app'\n  password: 'pw'\n",
    );
    await writeFile(join(workDir, "app-config.production.yaml"), "database:\n  pool_size: 100\n");

    // --- snippet start -----------------------------------------------
    // In the docs: `process.env.DAGSTACK_ENV = "production"`.
    // In the TS API this is equivalent to `options.dagstackEnv: "production"`.
    const config = await Config.load(join(workDir, "app-config.yaml"), {
      dagstackEnv: "production",
      env: {},
    });
    expect(config.getInt("database.pool_size")).toBe(100);
    // --- snippet end -------------------------------------------------
  });
});
