// Unit tests for the sources (YamlFileSource / JsonFileSource / InMemorySource).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConfigError } from "../src/index.js";
import {
  ConfigErrorReason,
  InMemorySource,
  JsonFileSource,
  YamlFileSource,
  isConfigError,
} from "../src/index.js";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-ts-sources-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeTempFile(name: string, content: string): Promise<string> {
  const path = join(workDir, name);
  await writeFile(path, content, "utf8");
  return path;
}

describe("YamlFileSource", () => {
  it("parses plain YAML", async () => {
    const file = await writeTempFile("plain.yaml", "llm:\n  base_url: https://api.test\n");
    const src = new YamlFileSource(file, { env: {} });
    expect(await src.load()).toEqual({ llm: { base_url: "https://api.test" } });
  });

  it("interpolates env variables before parse (${VAR} in non-string positions)", async () => {
    const file = await writeTempFile("interp.yaml", "server:\n  port: ${PORT}\n");
    const src = new YamlFileSource(file, { env: { PORT: "8080" } });
    const tree = (await src.load()) as { server: { port: number } };
    expect(tree.server.port).toBe(8080);
    expect(Number.isInteger(tree.server.port)).toBe(true);
  });

  it("normalizes whole-number floats to integer form (v2.1 §4.3)", async () => {
    const file = await writeTempFile(
      "floats.yaml",
      "ports:\n  http: 8080.0\nratio: 0.75\nzero: -0.0\n",
    );
    const src = new YamlFileSource(file, { env: {} });
    const tree = (await src.load()) as {
      ports: { http: number };
      ratio: number;
      zero: number;
    };
    expect(Number.isInteger(tree.ports.http)).toBe(true);
    expect(tree.ports.http).toBe(8080);
    expect(tree.ratio).toBe(0.75);
    expect(Number.isInteger(tree.ratio)).toBe(false);
    expect(tree.zero).toBe(0);
  });

  it("exposes id with yaml: prefix", () => {
    const src = new YamlFileSource("/tmp/file.yaml");
    expect(src.id).toBe("yaml:/tmp/file.yaml");
    expect(src.interpolate).toBe(true);
  });

  it("reports SOURCE_UNAVAILABLE for a missing file", async () => {
    const src = new YamlFileSource(join(workDir, "nonexistent.yaml"), { env: {} });
    await expect(src.load()).rejects.toSatisfy((err: unknown) => {
      return (
        isConfigError(err) &&
        err.reason === ConfigErrorReason.SOURCE_UNAVAILABLE &&
        err.sourceId?.includes("yaml:")
      );
    });
  });

  it("reports PARSE_ERROR on invalid YAML", async () => {
    const file = await writeTempFile("bad.yaml", "key: [unclosed\n");
    const src = new YamlFileSource(file, { env: {} });
    try {
      await src.load();
      expect.fail("expected ConfigError");
    } catch (err) {
      expect(isConfigError(err)).toBe(true);
      expect((err as ConfigError).reason).toBe(ConfigErrorReason.PARSE_ERROR);
    }
  });

  it("rejects non-mapping root", async () => {
    const file = await writeTempFile("array.yaml", "- a\n- b\n");
    const src = new YamlFileSource(file, { env: {} });
    try {
      await src.load();
      expect.fail("expected ConfigError");
    } catch (err) {
      expect((err as ConfigError).reason).toBe(ConfigErrorReason.PARSE_ERROR);
      expect((err as ConfigError).details).toContain("mapping");
    }
  });

  it("empty file returns empty tree", async () => {
    const file = await writeTempFile("empty.yaml", "");
    const src = new YamlFileSource(file, { env: {} });
    expect(await src.load()).toEqual({});
  });
});

describe("JsonFileSource", () => {
  it("parses plain JSON", async () => {
    const file = await writeTempFile("plain.json", '{"llm":{"model":"gpt-4"}}');
    const src = new JsonFileSource(file, { env: {} });
    expect(await src.load()).toEqual({ llm: { model: "gpt-4" } });
  });

  it("interpolates env before parse", async () => {
    const file = await writeTempFile("interp.json", '{"host":"${HOST}"}');
    const src = new JsonFileSource(file, { env: { HOST: "example.com" } });
    expect(await src.load()).toEqual({ host: "example.com" });
  });

  it("normalizes whole-number floats", async () => {
    const file = await writeTempFile("floats.json", '{"port":8080.0,"ratio":0.75}');
    const src = new JsonFileSource(file, { env: {} });
    const tree = (await src.load()) as { port: number; ratio: number };
    expect(Number.isInteger(tree.port)).toBe(true);
    expect(tree.port).toBe(8080);
    expect(tree.ratio).toBe(0.75);
  });

  it("id prefix", () => {
    const src = new JsonFileSource("/tmp/c.json");
    expect(src.id).toBe("json:/tmp/c.json");
  });

  it("PARSE_ERROR on invalid JSON", async () => {
    const file = await writeTempFile("bad.json", '{"unterminated');
    const src = new JsonFileSource(file, { env: {} });
    try {
      await src.load();
      expect.fail("expected ConfigError");
    } catch (err) {
      expect((err as ConfigError).reason).toBe(ConfigErrorReason.PARSE_ERROR);
    }
  });
});

describe("InMemorySource", () => {
  it("returns given tree", async () => {
    const src = new InMemorySource({ a: { b: 1 } });
    expect(await src.load()).toEqual({ a: { b: 1 } });
  });

  it("custom id", () => {
    const src = new InMemorySource({}, { id: "test-fixture" });
    expect(src.id).toBe("test-fixture");
  });

  it("interpolate flag default false", () => {
    expect(new InMemorySource({}).interpolate).toBe(false);
    expect(new InMemorySource({}, { interpolate: true }).interpolate).toBe(true);
  });
});
