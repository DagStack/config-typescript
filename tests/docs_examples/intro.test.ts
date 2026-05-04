// Auto-tests for the code snippets in `config-docs/site/docs/intro.mdx`
// (TypeScript TabItem).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { Config } from "../../src/index.js";

// Fixture YAML — an exact copy of the example from intro.mdx, the
// "Installation" section (the `app-config.yaml` block). ADR-0001 v2.1 §4.4:
// env-substituted strings are coerced to the zod schema via the
// `coerceEnvStringsForSchema` walker inside getSection, so
// `port: "${DB_PORT:-5432}"` validates against `z.number().int()` without
// any extra `.coerce`.
const APP_CONFIG_YAML = `app:
  name: "order-service"
  tagline: "Order processor"

database:
  host: "\${DB_HOST:-localhost}"
  port: "\${DB_PORT:-5432}"
  name: "\${DB_NAME:-orders}"
  user: "\${DB_USER}"
  password: "\${DB_PASSWORD}"
  pool_size: 20

cache:
  url: "\${REDIS_URL:-redis://localhost:6379/0}"
  ttl_min: 15

api:
  host: "0.0.0.0"
  port: 8080
  request_timeout_s: 30
`;

let workDir: string;
let cfgPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-ts-docs-intro-"));
  cfgPath = join(workDir, "app-config.yaml");
  await writeFile(cfgPath, APP_CONFIG_YAML);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── Section "Loading and reading" ───────────────────────────────────

describe("intro.mdx — Loading and reading (TypeScript)", () => {
  it("snippet: basic access methods + default", async () => {
    // --- snippet start -----------------------------------------------
    // import { Config } from "@dagstack/config";
    // (import is hoisted to the top of the file)

    const config = await Config.load(cfgPath, {
      env: { DB_USER: "app", DB_PASSWORD: "test-pw" },
    });

    // Basic access methods:
    // console.log(config.getString("app.name"));            // "order-service"
    // console.log(config.getInt("database.pool_size"));     // 20
    // console.log(config.getInt("api.port"));               // 8080

    // With a default — if the path is missing, the default is returned:
    // console.log(config.getInt("api.max_body_mb", 10));    // 10
    // --- snippet end -------------------------------------------------

    // Assertions for the expectations from the snippet comments.
    expect(config.getString("app.name")).toBe("order-service");
    expect(config.getInt("database.pool_size")).toBe(20);
    expect(config.getInt("api.port")).toBe(8080);
    expect(config.getInt("api.max_body_mb", 10)).toBe(10);
  });
});

// ── Section "Typed access" ──────────────────────────────────────────

describe("intro.mdx — Typed access (TypeScript)", () => {
  it("snippet: zod schema + getSection", async () => {
    // --- snippet start -----------------------------------------------
    // import { z } from "zod";
    // import { Config } from "@dagstack/config";

    const DatabaseConfig = z.object({
      host: z.string(),
      port: z.number().int().min(1).max(65535).default(5432),
      name: z.string(),
      user: z.string(),
      password: z.string().min(1),
      pool_size: z.number().int().min(1).max(1000).default(20),
    });

    const config = await Config.load(cfgPath, {
      env: { DB_USER: "app", DB_PASSWORD: "test-pw" },
    });
    const db = config.getSection("database", DatabaseConfig);
    // const pool = createPool({ host: db.host, port: db.port, poolSize: db.pool_size });
    //   ^^ createPool is a user function in the snippet, commented out here.
    // --- snippet end -------------------------------------------------

    // Validation passed and the values match the YAML.
    expect(db.host).toBe("localhost");
    expect(db.port).toBe(5432);
    expect(db.name).toBe("orders");
    expect(db.user).toBe("app");
    expect(db.password).toBe("test-pw");
    expect(db.pool_size).toBe(20);
  });
});
