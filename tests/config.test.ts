// Unit tests for the Config class (load, loadFrom, getters, getSection).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ConfigError } from "../src/index.js";
import { Config, ConfigErrorReason, InMemorySource, isConfigError } from "../src/index.js";
import type { ConfigTree } from "../src/types.js";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-ts-config-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// Test-only helper: assembles a Config from a ready-made tree via
// InMemorySource. Kept local so we do not expand the public Config API
// with a helper factory.
async function buildConfig(tree: ConfigTree): Promise<Config> {
  return Config.loadFrom([new InMemorySource(tree)]);
}

describe("Config.load — layering", () => {
  it("merges base + local + env-specific layers in order", async () => {
    const base = join(workDir, "cfg.yaml");
    await writeFile(base, "a: base\nb: 1\n");
    await writeFile(join(workDir, "cfg.local.yaml"), "a: local\n");
    await writeFile(join(workDir, "cfg.production.yaml"), "b: 2\n");

    const cfg = await Config.load(base, { dagstackEnv: "production", env: {} });
    expect(cfg.getString("a")).toBe("local");
    expect(cfg.getInt("b")).toBe(2);
    expect(cfg.sourceIds()).toHaveLength(3);
  });

  it("silently skips missing optional layers", async () => {
    const base = join(workDir, "cfg2.yaml");
    await writeFile(base, "only: me\n");
    const cfg = await Config.load(base, { dagstackEnv: null, env: {} });
    expect(cfg.getString("only")).toBe("me");
    expect(cfg.sourceIds()).toHaveLength(1);
  });
});

describe("Config.loadFrom — explicit sources", () => {
  it("deep-merges objects and atomically replaces arrays", async () => {
    const cfg = await Config.loadFrom([
      new InMemorySource({ a: { x: 1, y: 2 }, list: [1, 2, 3] }),
      new InMemorySource({ a: { y: 99, z: 3 }, list: [9] }),
    ]);
    expect(cfg.snapshot()).toEqual({ a: { x: 1, y: 99, z: 3 }, list: [9] });
  });

  it("empty sources → empty tree (not an error)", async () => {
    const cfg = await Config.loadFrom([]);
    expect(cfg.snapshot()).toEqual({});
  });
});

describe("has / get", () => {
  it("has returns true for an explicit null", async () => {
    const cfg = await buildConfig({ x: null });
    expect(cfg.has("x")).toBe(true);
    expect(cfg.get("x")).toBeNull();
  });

  it("get with default returns the default when missing", async () => {
    const cfg = await buildConfig({});
    expect(cfg.get("absent", "fallback")).toBe("fallback");
  });

  it("get without a default throws MISSING", async () => {
    const cfg = await buildConfig({});
    try {
      cfg.get("absent");
      expect.fail("should have thrown");
    } catch (err) {
      expect(isConfigError(err)).toBe(true);
      expect((err as ConfigError).reason).toBe(ConfigErrorReason.MISSING);
    }
  });
});

describe("getString — strict (v2.1 §4.3)", () => {
  it("accepts plain string", async () => {
    const cfg = await buildConfig({ x: "hello" });
    expect(cfg.getString("x")).toBe("hello");
  });

  it("rejects int without coerce (breaking vs Python v0.1)", async () => {
    const cfg = await buildConfig({ x: 42 });
    try {
      cfg.getString("x");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ConfigError).reason).toBe(ConfigErrorReason.TYPE_MISMATCH);
    }
  });

  it("rejects bool / number / null / object", async () => {
    const cfg = await buildConfig({ a: true, b: 1.5, c: null, d: { nested: 1 } });
    for (const key of ["a", "b", "c", "d"]) {
      expect(() => cfg.getString(key)).toThrow();
    }
  });

  it("default returned when missing", async () => {
    const cfg = await buildConfig({});
    expect(cfg.getString("x", "fallback")).toBe("fallback");
  });
});

describe("getInt — strict + whole-number float accept (v2.1 §4.3)", () => {
  it("native int", async () => {
    const cfg = await buildConfig({ x: 42 });
    expect(cfg.getInt("x")).toBe(42);
  });

  it("numeric string matching ^-?\\d+$", async () => {
    const cfg = await buildConfig({ x: "42", y: "-7" });
    expect(cfg.getInt("x")).toBe(42);
    expect(cfg.getInt("y")).toBe(-7);
  });

  it("whole-number float in the safe range", async () => {
    // `100.0` === `100` in JS, but the invariant is what matters: after the
    // source's normalize step it is `100`, and getInt accepts it.
    const cfg = await buildConfig({ x: 100, y: -42, z: 0 });
    expect(cfg.getInt("x")).toBe(100);
    expect(cfg.getInt("y")).toBe(-42);
    expect(cfg.getInt("z")).toBe(0);
  });

  it("rejects fractional number", async () => {
    const cfg = await buildConfig({ x: 1.5 });
    try {
      cfg.getInt("x");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ConfigError).details).toContain("fractional");
    }
  });

  it("rejects bool (bool is not int)", async () => {
    const cfg = await buildConfig({ x: true });
    try {
      cfg.getInt("x");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ConfigError).details).toContain("bool");
    }
  });

  it("rejects numbers outside i-JSON safe range", async () => {
    const cfg = await buildConfig({ x: 2 ** 55 });
    try {
      cfg.getInt("x");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ConfigError).details).toContain("safe range");
    }
  });
});

describe("getNumber", () => {
  it("int / float / numeric string", async () => {
    const cfg = await buildConfig({ a: 42, b: 3.14, c: "2.5", d: "1e3" });
    expect(cfg.getNumber("a")).toBe(42);
    expect(cfg.getNumber("b")).toBe(3.14);
    expect(cfg.getNumber("c")).toBe(2.5);
    expect(cfg.getNumber("d")).toBe(1000);
  });

  it("rejects bool and non-numeric string", async () => {
    const cfg = await buildConfig({ a: true, b: "abc" });
    expect(() => cfg.getNumber("a")).toThrow();
    expect(() => cfg.getNumber("b")).toThrow();
  });
});

describe("getBool — spec §4.3 string aliases", () => {
  it("true/false native", async () => {
    const cfg = await buildConfig({ a: true, b: false });
    expect(cfg.getBool("a")).toBe(true);
    expect(cfg.getBool("b")).toBe(false);
  });

  it("case-insensitive strings true|false|yes|no|1|0", async () => {
    const cfg = await buildConfig({
      t1: "true",
      t2: "YES",
      t3: "1",
      f1: "false",
      f2: "No",
      f3: "0",
    });
    expect(cfg.getBool("t1")).toBe(true);
    expect(cfg.getBool("t2")).toBe(true);
    expect(cfg.getBool("t3")).toBe(true);
    expect(cfg.getBool("f1")).toBe(false);
    expect(cfg.getBool("f2")).toBe(false);
    expect(cfg.getBool("f3")).toBe(false);
  });

  it("rejects other strings and numbers", async () => {
    const cfg = await buildConfig({ a: "maybe", b: 1 });
    expect(() => cfg.getBool("a")).toThrow();
    expect(() => cfg.getBool("b")).toThrow();
  });
});

describe("getList", () => {
  it("returns array as-is", async () => {
    const cfg = await buildConfig({ items: [1, 2, 3] });
    expect(cfg.getList("items")).toEqual([1, 2, 3]);
  });

  it("rejects non-array", async () => {
    const cfg = await buildConfig({ x: "string" });
    expect(() => cfg.getList("x")).toThrow();
  });
});

describe("getSection — zod validation", () => {
  it("validates valid subtree", async () => {
    const cfg = await buildConfig({
      database: { host: "https://api.test", timeout_ms: 1024 },
    });
    const schema = z.object({ host: z.string(), timeout_ms: z.number() });
    expect(cfg.getSection("database", schema)).toEqual({
      host: "https://api.test",
      timeout_ms: 1024,
    });
  });

  it("throws TYPE_MISMATCH on a native non-string in a string field (§4.4 M1)", async () => {
    // ADR v2.1 §4.4 reverse case: a native int/float/bool in a string field →
    // type_mismatch (mirror of §4.3 getString strict mode). Guards against
    // a silent `dimension: 768` → `"768"`.
    const cfg = await buildConfig({ database: { host: 42 } });
    const schema = z.object({ host: z.string() });
    try {
      cfg.getSection("database", schema);
      expect.fail("should have thrown");
    } catch (err) {
      const cfgErr = err as ConfigError;
      expect(cfgErr.reason).toBe(ConfigErrorReason.TYPE_MISMATCH);
      // §4.5 path preservation: full path section.field.
      expect(cfgErr.path).toBe("database.host");
    }
  });

  it("throws MISSING for an absent path", async () => {
    const cfg = await buildConfig({});
    const schema = z.object({ x: z.string() });
    try {
      cfg.getSection("database", schema);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ConfigError).reason).toBe(ConfigErrorReason.MISSING);
    }
  });
});

describe("snapshot — deep clone", () => {
  it("mutating the snapshot does not change the config", async () => {
    const cfg = await buildConfig({ a: { b: 1 } });
    const snap = cfg.snapshot() as { a: { b: number } };
    snap.a.b = 999;
    expect(cfg.getInt("a.b")).toBe(1);
  });
});
