// Phase 2 runtime API: refreshSecrets / snapshot semantics.
//
// Per ADR-0002 §3:
// - Config.refreshSecrets() MUST drop the cache and force re-resolution
//   on next access (manual rotation hook).
// - Config.snapshot() MUST replace every SecretRef with [MASKED] and
//   apply field-name suffix masking by default; with
//   `{includeSecrets: true}` it resolves SecretRef placeholders and
//   applies field-name suffix masking (audit-mode opt-in).
//
// TS is eager-by-default, so the test fixtures construct an in-process
// SecretSource that records every resolve() call and lets us flip the
// returned value to verify refresh semantics.

import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config } from "../src/config.js";
import { type ResolveContext, type SecretSource, type SecretValue } from "../src/secrets.js";
import { MASKED_PLACEHOLDER } from "../src/secrets-mask.js";
import { YamlFileSource } from "../src/sources.js";

class CountingSource implements SecretSource {
  readonly scheme = "ctr";
  readonly id = "ctr:test";
  value: string;
  expiresAt: Date | undefined;
  resolveCalls: string[] = [];

  constructor(value = "v1", expiresAt?: Date) {
    this.value = value;
    this.expiresAt = expiresAt;
  }

  resolve(path: string, _ctx: ResolveContext): Promise<SecretValue> {
    this.resolveCalls.push(path);
    return Promise.resolve({
      value: this.value,
      sourceId: this.id,
      expiresAt: this.expiresAt,
    });
  }
}

function writeYaml(body: string): YamlFileSource {
  const dir = mkdtempSync(join(tmpdir(), "phase2-runtime-"));
  const file = join(dir, "c.yaml");
  writeFileSync(file, body);
  return new YamlFileSource(file);
}

describe("Config.refreshSecrets()", () => {
  let src: CountingSource;

  beforeEach(() => {
    src = new CountingSource("v1");
  });

  it("re-resolves every reference on next read", async () => {
    const cfg = await Config.loadFrom([writeYaml("k: ${secret:ctr:foo}\n"), src]);
    expect(cfg.getString("k")).toBe("v1");
    expect(src.resolveCalls).toEqual(["foo"]);

    src.value = "v2";
    expect(cfg.getString("k")).toBe("v1"); // resolved-tree still serves old

    await cfg.refreshSecrets();
    expect(cfg.getString("k")).toBe("v2");
    expect(src.resolveCalls).toEqual(["foo", "foo"]);
  });

  it("re-walks the original tree (multiple references)", async () => {
    const cfg = await Config.loadFrom([
      writeYaml("a: ${secret:ctr:foo}\nb: ${secret:ctr:foo}\nc: literal\n"),
      src,
    ]);
    // Cache deduplicates within a single walk; foo is fetched once.
    expect(src.resolveCalls).toEqual(["foo"]);

    await cfg.refreshSecrets();
    // Same dedup applies on refresh — second walk also one fetch.
    expect(src.resolveCalls).toEqual(["foo", "foo"]);
    expect(cfg.getString("a")).toBe("v1");
    expect(cfg.getString("b")).toBe("v1");
    expect(cfg.getString("c")).toBe("literal");
  });
});

describe("expiresAt honoured at resolution-walk cache", () => {
  it("re-fetches a stale secret on refreshSecrets()", async () => {
    const past = new Date(Date.now() - 1_000);
    const src = new CountingSource("v1", past);
    await Config.loadFrom([writeYaml("a: ${secret:ctr:foo}\nb: ${secret:ctr:foo}\n"), src]);
    // a + b share the same cache key but the cached value is already
    // expired, so each ref triggers a fresh resolve() within the walk.
    expect(src.resolveCalls).toEqual(["foo", "foo"]);
  });

  it("dedupes within a walk when expiresAt is in the future", async () => {
    const future = new Date(Date.now() + 60_000);
    const src = new CountingSource("v1", future);
    await Config.loadFrom([writeYaml("a: ${secret:ctr:foo}\nb: ${secret:ctr:foo}\n"), src]);
    // Cache hit on `b` — only one round-trip total.
    expect(src.resolveCalls).toEqual(["foo"]);
  });

  it("dedupes within a walk when expiresAt is undefined", async () => {
    const src = new CountingSource("v1");
    await Config.loadFrom([writeYaml("a: ${secret:ctr:foo}\nb: ${secret:ctr:foo}\n"), src]);
    expect(src.resolveCalls).toEqual(["foo"]);
  });
});

describe("refreshSecrets() atomicity", () => {
  it("leaves the previously resolved tree active on backend failure", async () => {
    let value = "v1";
    let shouldFail = false;
    const src: SecretSource = {
      scheme: "atomic",
      id: "atomic:test",
      resolve(_path: string, _ctx: ResolveContext): Promise<SecretValue> {
        if (shouldFail) {
          return Promise.reject(new Error("backend down"));
        }
        return Promise.resolve({ value, sourceId: "atomic:test" });
      },
    };

    const cfg = await Config.loadFrom([writeYaml("k: ${secret:atomic:foo}\n"), src]);
    expect(cfg.getString("k")).toBe("v1");

    value = "v2";
    shouldFail = true;
    await expect(cfg.refreshSecrets()).rejects.toThrow();
    // Previous resolution remains active.
    expect(cfg.getString("k")).toBe("v1");

    shouldFail = false;
    await cfg.refreshSecrets();
    expect(cfg.getString("k")).toBe("v2");
  });
});

describe("Config.snapshot()", () => {
  it("default: masks SecretRef placeholders without resolving", async () => {
    const src = new CountingSource("should-not-appear");
    const cfg = await Config.loadFrom([
      writeYaml("api_key: ${secret:ctr:foo}\nplain: hello\n"),
      src,
    ]);
    src.resolveCalls = []; // ignore the loadFrom-time eager resolve

    const snap = cfg.snapshot();
    expect(snap).toEqual({ api_key: MASKED_PLACEHOLDER, plain: "hello" });
    expect(src.resolveCalls).toEqual([]);
  });

  it("masks plain string under a secret name (field-name pattern)", async () => {
    const cfg = await Config.loadFrom([writeYaml("password: hunter2\nuser: alice\n")]);
    const snap = cfg.snapshot();
    expect(snap).toEqual({ password: MASKED_PLACEHOLDER, user: "alice" });
  });

  it("includeSecrets:true returns resolved values, still field-masking by name", async () => {
    const src = new CountingSource("resolved-secret");
    const cfg = await Config.loadFrom([
      writeYaml("api_key: ${secret:ctr:foo}\nendpoint: ${secret:ctr:bar}\n"),
      src,
    ]);
    const snap = cfg.snapshot({ includeSecrets: true });
    // api_key matches secret-name pattern → still masked.
    expect(snap.api_key).toBe(MASKED_PLACEHOLDER);
    // endpoint does not match → resolved value visible.
    expect(snap.endpoint).toBe("resolved-secret");
  });

  it("returns an independent copy", async () => {
    const cfg = await Config.loadFrom([writeYaml("x: { y: 1 }\n")]);
    const snap = cfg.snapshot() as { x: { y: number } };
    snap.x.y = 999;
    expect(cfg.getInt("x.y")).toBe(1);
  });
});
