import { describe, expect, it } from "vitest";

import { Config, ConfigError, ConfigErrorReason, InMemorySource } from "../src/index.js";
import {
  EnvSecretSource,
  isSecretRef,
  type ResolveContext,
  type SecretSource,
  type SecretValue,
} from "../src/secrets.js";
import { parseSecretRef, walkSecretRefs } from "../src/secret-grammar.js";

// ── parseSecretRef ────────────────────────────────────────────────────

describe("parseSecretRef — grammar (ADR-0002 v1.1 §1)", () => {
  it("parses minimal env reference", () => {
    const ref = parseSecretRef("env:OPENAI_API_KEY");
    expect(ref.scheme).toBe("env");
    expect(ref.path).toBe("OPENAI_API_KEY");
    expect(ref.default).toBeUndefined();
  });

  it("parses default value", () => {
    const ref = parseSecretRef("env:VAR:-fallback-value");
    expect(ref.scheme).toBe("env");
    expect(ref.path).toBe("VAR");
    expect(ref.default).toBe("fallback-value");
  });

  it("parses field projection", () => {
    const ref = parseSecretRef("vault:secret/db#password");
    expect(ref.scheme).toBe("vault");
    expect(ref.path).toBe("secret/db#password");
  });

  it("parses query and field together", () => {
    const ref = parseSecretRef("vault:secret/db?version=3#password");
    expect(ref.path).toBe("secret/db?version=3#password");
  });

  it("parses query, field, and default together", () => {
    const ref = parseSecretRef("vault:secret/db?version=3#password:-fb");
    expect(ref.path).toBe("secret/db?version=3#password");
    expect(ref.default).toBe("fb");
  });

  it("doubled # in path becomes literal #", () => {
    const ref = parseSecretRef("vault:tag##v2/db");
    expect(ref.path).toBe("tag#v2/db");
  });

  it("doubled ? in path becomes literal ?", () => {
    const ref = parseSecretRef("vault:where??name=foo");
    expect(ref.path).toBe("where?name=foo");
  });

  it("doubled :: before -:- escape", () => {
    const ref = parseSecretRef("vault:foo::-bar:-default");
    expect(ref.path).toBe("foo:-bar");
    expect(ref.default).toBe("default");
  });

  it("percent-encoded value in query is decoded", () => {
    const ref = parseSecretRef("vault:secret/db?token=val%26with%3Dchars");
    expect(ref.path).toBe("secret/db?token=val&with=chars");
  });

  it("uppercase scheme rejected", () => {
    expect(() => parseSecretRef("Vault:path")).toThrow(ConfigError);
  });

  it("missing scheme separator rejected", () => {
    expect(() => parseSecretRef("envOPENAI_API_KEY")).toThrow(ConfigError);
  });

  it("unescaped ? rejected (orphan, no =)", () => {
    expect(() => parseSecretRef("vault:foo?bar")).toThrow(ConfigError);
  });
});

// ── walkSecretRefs ─────────────────────────────────────────────────────

describe("walkSecretRefs", () => {
  it("converts scalar token to SecretRef", () => {
    const out = walkSecretRefs({ k: "${secret:env:VAR}" }, "test");
    const k = (out as { k: unknown }).k;
    expect(isSecretRef(k)).toBe(true);
    if (isSecretRef(k)) expect(k.scheme).toBe("env");
  });

  it("plain string passes through", () => {
    const out = walkSecretRefs({ k: "literal" }, "t");
    expect((out as { k: string }).k).toBe("literal");
  });

  it("recurses into nested objects + arrays", () => {
    const out = walkSecretRefs(
      { a: { b: "${secret:env:A}" }, c: ["${secret:env:B}", "literal"] },
      "t",
    ) as { a: { b: unknown }; c: unknown[] };
    expect(isSecretRef(out.a.b)).toBe(true);
    expect(isSecretRef(out.c[0])).toBe(true);
    expect(out.c[1]).toBe("literal");
  });

  it("token mixed with text rejected", () => {
    expect(() => walkSecretRefs({ k: "prefix ${secret:env:V} suffix" }, "t")).toThrow(ConfigError);
  });
});

// ── EnvSecretSource ────────────────────────────────────────────────────

describe("EnvSecretSource", () => {
  it("resolves existing env var", async () => {
    const src = new EnvSecretSource({ lookup: (n) => (n === "K" ? "v" : undefined) });
    const result = await src.resolve("K", { attempt: 1 });
    expect(result.value).toBe("v");
  });

  it("missing env var raises SECRET_UNRESOLVED", async () => {
    const src = new EnvSecretSource({ lookup: () => undefined });
    await expect(src.resolve("X", { attempt: 1 })).rejects.toMatchObject({
      reason: ConfigErrorReason.SECRET_UNRESOLVED,
    });
  });

  it("rejects #field projection (env values are opaque)", async () => {
    const src = new EnvSecretSource({ lookup: (n) => (n === "K" ? "v" : undefined) });
    await expect(src.resolve("K#sub", { attempt: 1 })).rejects.toMatchObject({
      reason: ConfigErrorReason.SECRET_UNRESOLVED,
    });
  });

  it("rejects ?query (env values are opaque)", async () => {
    const src = new EnvSecretSource({ lookup: (n) => (n === "K" ? "v" : undefined) });
    await expect(src.resolve("K?version=1", { attempt: 1 })).rejects.toMatchObject({
      reason: ConfigErrorReason.SECRET_UNRESOLVED,
    });
  });
});

// ── End-to-end via Config.loadFrom ─────────────────────────────────────

class CountingEnv implements SecretSource {
  scheme = "env";
  id = "test:counting";
  calls: string[] = [];

  constructor(private readonly table: Record<string, string>) {}

  resolve(path: string, _ctx: ResolveContext): Promise<SecretValue> {
    this.calls.push(path);
    if (!(path in this.table)) {
      return Promise.reject(
        new ConfigError({
          path: "",
          reason: ConfigErrorReason.SECRET_UNRESOLVED,
          details: `missing ${path}`,
          sourceId: this.id,
        }),
      );
    }
    return Promise.resolve({ value: this.table[path] ?? "", sourceId: this.id });
  }
}

describe("Config.loadFrom + SecretSource (eager resolution)", () => {
  it("resolves env reference end-to-end", async () => {
    const src = new InMemorySource({ k: "${secret:env:V}" });
    const env = new EnvSecretSource({ lookup: (n) => (n === "V" ? "value" : undefined) });
    const cfg = await Config.loadFrom([src, env]);
    expect(cfg.getString("k")).toBe("value");
  });

  it("uses default when env var missing", async () => {
    const src = new InMemorySource({ k: "${secret:env:NO_SUCH:-fb}" });
    const env = new EnvSecretSource({ lookup: () => undefined });
    const cfg = await Config.loadFrom([src, env]);
    expect(cfg.getString("k")).toBe("fb");
  });

  it("unknown scheme without default raises at load time", async () => {
    const src = new InMemorySource({ k: "${secret:vault:secret/db#pw}" });
    await expect(Config.loadFrom([src])).rejects.toMatchObject({
      reason: ConfigErrorReason.SECRET_UNRESOLVED,
    });
  });

  it("unknown scheme with default resolves to default", async () => {
    const src = new InMemorySource({ k: "${secret:vault:secret/db#pw:-fb}" });
    const cfg = await Config.loadFrom([src]);
    expect(cfg.getString("k")).toBe("fb");
  });

  it("cache hits one resolve per unique path", async () => {
    const src = new InMemorySource({
      a: "${secret:env:K}",
      b: "${secret:env:K}",
    });
    const env = new CountingEnv({ K: "v" });
    const cfg = await Config.loadFrom([src, env]);
    expect(cfg.getString("a")).toBe("v");
    expect(cfg.getString("b")).toBe("v");
    expect(env.calls).toEqual(["K"]);
  });

  it("getInt resolves and coerces", async () => {
    const src = new InMemorySource({ port: "${secret:env:PORT}" });
    const env = new EnvSecretSource({ lookup: (n) => (n === "PORT" ? "8080" : undefined) });
    const cfg = await Config.loadFrom([src, env]);
    expect(cfg.getInt("port")).toBe(8080);
  });

  it("auto-registers EnvSecretSource if no SecretSource passed", async () => {
    const src = new InMemorySource({ k: "${secret:env:DEFINITELY_NOT_SET_XXX}" });
    await expect(Config.loadFrom([src])).rejects.toMatchObject({
      reason: ConfigErrorReason.SECRET_UNRESOLVED,
      details: expect.stringContaining("not set in the process environment") as unknown,
    });
  });

  it("explicit EnvSecretSource overrides default", async () => {
    const src = new InMemorySource({ k: "${secret:env:V}" });
    const env = new EnvSecretSource({ lookup: () => "from-explicit" });
    const cfg = await Config.loadFrom([src, env]);
    expect(cfg.getString("k")).toBe("from-explicit");
  });

  it("duplicate scheme registration raises VALIDATION_FAILED", async () => {
    const env1 = new EnvSecretSource();
    const env2 = new EnvSecretSource();
    await expect(Config.loadFrom([env1, env2])).rejects.toMatchObject({
      reason: ConfigErrorReason.VALIDATION_FAILED,
    });
  });
});

describe("Phase 1 ${VAR} backwards compat", () => {
  it("${VAR} still works with explicit env", async () => {
    const tmp = `${process.cwd()}/tmp-test.yaml`;
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmp, "k: ${OPENAI_KEY}\n");
    try {
      const { YamlFileSource } = await import("../src/sources.js");
      const src = new YamlFileSource(tmp, { env: { OPENAI_KEY: "value-via-phase1" } });
      const cfg = await Config.loadFrom([src]);
      expect(cfg.getString("k")).toBe("value-via-phase1");
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
  });

  it("${secret:env:VAR} matches ${VAR} semantically", async () => {
    const tmp = `${process.cwd()}/tmp-test2.yaml`;
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmp, "phase1: ${KEY}\nphase2: ${secret:env:KEY}\n");
    try {
      const { YamlFileSource } = await import("../src/sources.js");
      const src = new YamlFileSource(tmp, { env: { KEY: "shared-value" } });
      const env = new EnvSecretSource({
        lookup: (n) => (n === "KEY" ? "shared-value" : undefined),
      });
      const cfg = await Config.loadFrom([src, env]);
      expect(cfg.getString("phase1")).toBe("shared-value");
      expect(cfg.getString("phase2")).toBe("shared-value");
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
  });
});
