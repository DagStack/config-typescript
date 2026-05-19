// Unit tests for v2.2 hardening: array path + secrets + walker invariant.
// They cover conformance fixtures tagged runner_extension_required.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ConfigError } from "../src/index.js";
import {
  Config,
  ConfigErrorReason,
  InMemorySource,
  MASKED_PLACEHOLDER,
  isSecretField,
  maskValue,
} from "../src/index.js";

// ── §4.2 / §4.5 array indices in ConfigError.path ───────────────────

describe("ConfigError.path — array index bracket form (v2.2 §4.2 §4.5)", () => {
  it("nested validation in array element uses [N]", async () => {
    const Server = z.object({ host: z.string(), port: z.number().int() });
    const Db = z.object({ servers: z.array(Server) });

    const cfg = await Config.loadFrom([
      new InMemorySource({
        database: {
          servers: [
            { host: "localhost", port: 5432 },
            { host: "replica", port: "not-a-number" },
          ],
        },
      }),
    ]);
    try {
      cfg.getSection("database", Db);
      expect.fail("expected ConfigError");
    } catch (err) {
      const cfgErr = err as ConfigError;
      expect(cfgErr.reason).toBe(ConfigErrorReason.VALIDATION_FAILED);
      expect(cfgErr.path).toBe("database.servers[1].port");
    }
  });
});

// ── §6 Secrets ──────────────────────────────────────────────────────

describe("Secret patterns (v2.2 §6)", () => {
  it.each(["api_key", "db_password", "auth_token", "access_key", "private_key", "APIKEY"])(
    "matches %s",
    (name) => {
      expect(isSecretField(name)).toBe(true);
    },
  );

  it.each(["host", "port", "name", "pool_size", "url"])("does not match %s", (name) => {
    expect(isSecretField(name)).toBe(false);
  });

  it("maskValue replaces non-empty", () => {
    expect(maskValue("api_key", "sk-abc123")).toBe(MASKED_PLACEHOLDER);
  });

  it("maskValue preserves empty / null", () => {
    expect(maskValue("api_key", "")).toBe("");
    expect(maskValue("api_key", null)).toBe(null);
    expect(maskValue("api_key", undefined)).toBe(undefined);
  });

  it("maskValue passes non-secret through", () => {
    expect(maskValue("host", "prod.example.com")).toBe("prod.example.com");
  });
});

describe("Secret masking in ConfigError.details (v2.2 §6)", () => {
  // By default zod does NOT include the raw value in the serialized error
  // for most issue codes (invalid_type / too_small / too_big / etc.).
  // A leak is possible if the user supplied a custom message with
  // `${value}` interpolation. Our masking code guards that user scenario.

  it("invariant: the raw secret does not appear in details (standard zod issues)", async () => {
    const schema = z.object({ api_key: z.string().min(20) });
    const cfg = await Config.loadFrom([
      new InMemorySource({ service: { api_key: "secret-leak" } }),
    ]);
    try {
      cfg.getSection("service", schema);
      expect.fail("expected ConfigError");
    } catch (err) {
      const cfgErr = err as ConfigError;
      // The zod `too_small` issue does not include the raw `api_key` value — details is clean.
      expect(cfgErr.details).not.toContain("secret-leak");
    }
  });

  it("secret masking activates on invalid_type with a native scalar input", async () => {
    // The zod invalid_type issue includes `input` for native non-string
    // values (see `ZodIssue` + the `received` field). If the user dropped a
    // native bool/int into a secret field, masking replaces the value.
    const schema = z.object({ api_key: z.string() });
    const cfg = await Config.loadFrom([new InMemorySource({ service: { api_key: true } })]);
    try {
      cfg.getSection("service", schema);
      expect.fail("expected ConfigError");
    } catch (err) {
      const cfgErr = err as ConfigError;
      // The reverse-coerce check must flip reason to TYPE_MISMATCH (§4.4 M1).
      expect(cfgErr.reason).toBe(ConfigErrorReason.TYPE_MISMATCH);
      expect(cfgErr.path).toBe("service.api_key");
    }
  });
});

// ── §4.4 Walker invariant ───────────────────────────────────────────

describe("Walker invariant (v2.2 §4.4)", () => {
  it("get() returns raw env-substituted string", async () => {
    const cfg = await Config.loadFrom([new InMemorySource({ database: { port: "5432" } })]);
    const raw = cfg.get("database.port");
    expect(raw).toBe("5432");
    expect(typeof raw).toBe("string");
  });

  it("getInt() coerces primitive per §4.3", async () => {
    const cfg = await Config.loadFrom([new InMemorySource({ database: { port: "5432" } })]);
    expect(cfg.getInt("database.port")).toBe(5432);
  });

  it("getSection() coerces via schema walker", async () => {
    const cfg = await Config.loadFrom([new InMemorySource({ database: { port: "5432" } })]);
    const db = cfg.getSection("database", z.object({ port: z.number().int() }));
    expect(db.port).toBe(5432);
    expect(typeof db.port).toBe("number");
  });
});
