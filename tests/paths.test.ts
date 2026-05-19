import { describe, expect, it } from "vitest";

import { ConfigError } from "../src/errors.js";
import { getByPath, hasPath, parsePath } from "../src/paths.js";

describe("parsePath", () => {
  it("empty string → empty array", () => {
    expect(parsePath("")).toEqual([]);
  });

  it("simple key", () => {
    expect(parsePath("llm")).toEqual([{ kind: "key", value: "llm" }]);
  });

  it("nested keys", () => {
    expect(parsePath("llm.base_url")).toEqual([
      { kind: "key", value: "llm" },
      { kind: "key", value: "base_url" },
    ]);
  });

  it("deep nested", () => {
    expect(parsePath("a.b.c.d")).toEqual([
      { kind: "key", value: "a" },
      { kind: "key", value: "b" },
      { kind: "key", value: "c" },
      { kind: "key", value: "d" },
    ]);
  });

  it("array index", () => {
    expect(parsePath("dagstack.plugin_dirs[0]")).toEqual([
      { kind: "key", value: "dagstack" },
      { kind: "key", value: "plugin_dirs" },
      { kind: "index", value: 0 },
    ]);
  });

  it("wildcard array", () => {
    expect(parsePath("dagstack.plugin_dirs[*]")).toEqual([
      { kind: "key", value: "dagstack" },
      { kind: "key", value: "plugin_dirs" },
      { kind: "index", value: "*" },
    ]);
  });

  it("backslash-escaped dot in key", () => {
    expect(parsePath("labels.kubernetes\\.io/zone")).toEqual([
      { kind: "key", value: "labels" },
      { kind: "key", value: "kubernetes.io/zone" },
    ]);
  });

  it("multiple array indices in a row", () => {
    expect(parsePath("a[0][1]")).toEqual([
      { kind: "key", value: "a" },
      { kind: "index", value: 0 },
      { kind: "index", value: 1 },
    ]);
  });

  it("rejects trailing dot", () => {
    expect(() => parsePath("a.")).toThrow(ConfigError);
    expect(() => parsePath("a.")).toThrow(/trailing/);
  });

  it("rejects unclosed bracket", () => {
    expect(() => parsePath("a[0")).toThrow(ConfigError);
    expect(() => parsePath("a[0")).toThrow(/unclosed/);
  });

  it("rejects invalid index", () => {
    expect(() => parsePath("a[abc]")).toThrow(/invalid index/);
    expect(() => parsePath("a[-1]")).toThrow(/invalid index/);
  });

  it("rejects leading dot", () => {
    expect(() => parsePath(".a")).toThrow(/unexpected/);
  });

  it("rejects array index exceeding safe integer range", () => {
    // Number("99999999999999999") = 1e17, precision is lost. The safe range
    // is ±(2^53 - 1) = 9007199254740991.
    expect(() => parsePath("a[99999999999999999]")).toThrow(/safe integer range/);
  });
});

describe("getByPath", () => {
  const tree = {
    llm: {
      base_url: "http://localhost",
      models: {
        default: "gpt-4o",
      },
    },
    plugins: ["chunker", "embedder", "retriever"],
    matrix: [
      [1, 2, 3],
      [4, 5, 6],
    ],
  } as const;

  it("root — empty path", () => {
    expect(getByPath(tree, [])).toBe(tree);
  });

  it("simple key", () => {
    expect(getByPath(tree, parsePath("llm"))).toEqual(tree.llm);
  });

  it("nested key", () => {
    expect(getByPath(tree, parsePath("llm.base_url"))).toBe("http://localhost");
    expect(getByPath(tree, parsePath("llm.models.default"))).toBe("gpt-4o");
  });

  it("array index", () => {
    expect(getByPath(tree, parsePath("plugins[0]"))).toBe("chunker");
    expect(getByPath(tree, parsePath("plugins[2]"))).toBe("retriever");
  });

  it("nested array", () => {
    expect(getByPath(tree, parsePath("matrix[1][2]"))).toBe(6);
  });

  it("wildcard returns copy of array", () => {
    const result = getByPath(tree, parsePath("plugins[*]"));
    expect(result).toEqual(["chunker", "embedder", "retriever"]);
    // Defensive copy — not the same reference.
    expect(result).not.toBe(tree.plugins);
  });

  it("missing key → undefined", () => {
    expect(getByPath(tree, parsePath("missing"))).toBeUndefined();
    expect(getByPath(tree, parsePath("llm.missing"))).toBeUndefined();
  });

  it("out-of-range index → undefined", () => {
    expect(getByPath(tree, parsePath("plugins[10]"))).toBeUndefined();
  });

  it("type-mismatch (key on array, index on object) → undefined", () => {
    expect(getByPath(tree, parsePath("plugins.nope"))).toBeUndefined();
    expect(getByPath(tree, parsePath("llm[0]"))).toBeUndefined();
  });

  it("null handling — null value is returned, traverse through null fails", () => {
    const withNull = { a: null, b: { c: null } };
    expect(getByPath(withNull, parsePath("a"))).toBeNull();
    expect(getByPath(withNull, parsePath("b.c"))).toBeNull();
    expect(getByPath(withNull, parsePath("a.nope"))).toBeUndefined();
  });
});

describe("hasPath", () => {
  const tree = {
    llm: { base_url: "x", model: null },
    plugins: ["a", "b"],
  };

  it("root — always true if tree defined", () => {
    expect(hasPath(tree, [])).toBe(true);
    expect(hasPath({}, [])).toBe(true);
    expect(hasPath(null, [])).toBe(true);
  });

  it("existing key → true", () => {
    expect(hasPath(tree, parsePath("llm"))).toBe(true);
    expect(hasPath(tree, parsePath("llm.base_url"))).toBe(true);
  });

  it("null value → true (key exists, value is null)", () => {
    expect(hasPath(tree, parsePath("llm.model"))).toBe(true);
  });

  it("missing key → false", () => {
    expect(hasPath(tree, parsePath("llm.missing"))).toBe(false);
    expect(hasPath(tree, parsePath("totally.missing.path"))).toBe(false);
  });

  it("array bounds", () => {
    expect(hasPath(tree, parsePath("plugins[0]"))).toBe(true);
    expect(hasPath(tree, parsePath("plugins[1]"))).toBe(true);
    expect(hasPath(tree, parsePath("plugins[2]"))).toBe(false);
  });

  it("wildcard on array → true", () => {
    expect(hasPath(tree, parsePath("plugins[*]"))).toBe(true);
  });
});
