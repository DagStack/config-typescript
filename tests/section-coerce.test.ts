// Native unit tests for §4.4 env-string coercion (v2.1) + §4.5 path preservation.
// These scenarios cover v2.1 conformance fixtures
// (runner_extension_required) that the conformance runner skips until the
// runner protocol is extended.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ConfigError } from "../src/index.js";
import { Config, ConfigErrorReason, InMemorySource, isConfigError } from "../src/index.js";

// ── §4.4 env-string coercion in number/int/bool fields ──────────────

describe("getSection — env-string coercion (v2.1 §4.4)", () => {
  it("coerces string → int", async () => {
    const cfg = await Config.loadFrom([
      new InMemorySource({ database: { port: "5432", pool_size: "20" } }),
    ]);
    const schema = z.object({
      port: z.number().int(),
      pool_size: z.number().int(),
    });
    const db = cfg.getSection("database", schema);
    expect(db.port).toBe(5432);
    expect(db.pool_size).toBe(20);
  });

  it("coerces string → float", async () => {
    const cfg = await Config.loadFrom([new InMemorySource({ rag: { min_score: "0.75" } })]);
    const schema = z.object({ min_score: z.number() });
    const rag = cfg.getSection("rag", schema);
    expect(rag.min_score).toBe(0.75);
  });

  it("coerces string → bool (true/yes/1)", async () => {
    const cfg = await Config.loadFrom([
      new InMemorySource({
        feature: { enabled: "true", beta: "yes", legacy: "0" },
      }),
    ]);
    const schema = z.object({
      enabled: z.boolean(),
      beta: z.boolean(),
      legacy: z.boolean(),
    });
    const f = cfg.getSection("feature", schema);
    expect(f.enabled).toBe(true);
    expect(f.beta).toBe(true);
    expect(f.legacy).toBe(false);
  });

  it("passthrough for native numeric (no coerce when the type already matches)", async () => {
    const cfg = await Config.loadFrom([new InMemorySource({ x: { n: 42 } })]);
    const schema = z.object({ n: z.number().int() });
    expect(cfg.getSection("x", schema).n).toBe(42);
  });

  it("does not break string fields with numeric-looking strings", async () => {
    // "42" in a string field stays a string — coerce is not applied.
    const cfg = await Config.loadFrom([new InMemorySource({ x: { label: "42" } })]);
    const schema = z.object({ label: z.string() });
    expect(cfg.getSection("x", schema).label).toBe("42");
  });
});

// ── §4.4 M1 reverse case: native non-string → string field = type_mismatch

describe("getSection — reverse coerce rejection (v2.1 §4.4 M1)", () => {
  it("native int in a string field → TYPE_MISMATCH", async () => {
    const cfg = await Config.loadFrom([new InMemorySource({ llm: { model: 42 } })]);
    const schema = z.object({ model: z.string() });
    try {
      cfg.getSection("llm", schema);
      expect.fail("expected ConfigError");
    } catch (err) {
      expect(isConfigError(err)).toBe(true);
      const cfgErr = err as ConfigError;
      expect(cfgErr.reason).toBe(ConfigErrorReason.TYPE_MISMATCH);
      // §4.5: full dot-notation path.
      expect(cfgErr.path).toBe("llm.model");
    }
  });

  it("native bool in a string field → TYPE_MISMATCH", async () => {
    const cfg = await Config.loadFrom([new InMemorySource({ api: { mode: true } })]);
    const schema = z.object({ mode: z.string() });
    try {
      cfg.getSection("api", schema);
      expect.fail("expected ConfigError");
    } catch (err) {
      const cfgErr = err as ConfigError;
      expect(cfgErr.reason).toBe(ConfigErrorReason.TYPE_MISMATCH);
    }
  });
});

// ── §4.5 path preservation for nested validation ────────────────────

describe("getSection — path preservation (v2.1 §4.5)", () => {
  it("nested invalid field → path = section.field", async () => {
    const cfg = await Config.loadFrom([new InMemorySource({ database: { pool_size: "twenty" } })]);
    const schema = z.object({ pool_size: z.number().int() });
    try {
      cfg.getSection("database", schema);
      expect.fail("expected ConfigError");
    } catch (err) {
      const cfgErr = err as ConfigError;
      expect(cfgErr.path).toBe("database.pool_size");
    }
  });
});
