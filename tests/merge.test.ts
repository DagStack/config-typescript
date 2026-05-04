import { describe, expect, it } from "vitest";

import { deepMerge, deepMergeAll } from "../src/merge.js";

describe("deepMerge — primitive replacement", () => {
  it("scalar override wins", () => {
    expect(deepMerge("a", "b")).toBe("b");
    expect(deepMerge(1, 2)).toBe(2);
    expect(deepMerge(true, false)).toBe(false);
    expect(deepMerge("x", null)).toBeNull();
  });

  it("null override overwrites", () => {
    expect(deepMerge({ a: 1 }, null)).toBeNull();
  });

  it("type mismatch — override wins (object vs scalar)", () => {
    expect(deepMerge({ a: 1 }, "scalar")).toBe("scalar");
    expect(deepMerge("scalar", { a: 1 })).toEqual({ a: 1 });
  });
});

describe("deepMerge — objects", () => {
  it("merges disjoint keys", () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("override replaces scalar leaf", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("deep recursive merge", () => {
    const base = { database: { name: "dev", pool_size: 20 } };
    const override = { database: { name: "prod" } };
    expect(deepMerge(base, override)).toEqual({
      database: { name: "prod", pool_size: 20 },
    });
  });

  it("layered config from ADR §3 example", () => {
    const baseConfig = {
      database: { host: "http://base", name: "dev" },
      cache: { ttl_min: 15, max_size_mb: 64 },
    };
    const override = {
      database: { name: "prod" },
      cache: { ttl_min: 30 },
    };
    expect(deepMerge(baseConfig, override)).toEqual({
      database: { host: "http://base", name: "prod" },
      cache: { ttl_min: 30, max_size_mb: 64 },
    });
  });

  it("does not mutate base or override", () => {
    const base = { a: { b: 1 } };
    const override = { a: { c: 2 } };
    const result = deepMerge(base, override);
    expect(base).toEqual({ a: { b: 1 } });
    expect(override).toEqual({ a: { c: 2 } });
    expect(result).toEqual({ a: { b: 1, c: 2 } });
  });
});

describe("deepMerge — arrays (atomic replace)", () => {
  it("array in override replaces array in base (NOT concatenation)", () => {
    expect(deepMerge(["a", "b", "c"], ["x"])).toEqual(["x"]);
  });

  it("array in nested position replaces", () => {
    const base = { plugins: ["chunker", "embedder"] };
    const override = { plugins: ["chunker"] };
    expect(deepMerge(base, override)).toEqual({ plugins: ["chunker"] });
  });

  it("empty array replaces non-empty", () => {
    expect(deepMerge({ tools: [1, 2, 3] }, { tools: [] })).toEqual({ tools: [] });
  });

  it("returned array is defensive copy (not same reference)", () => {
    const base = [1, 2, 3];
    const override = [4, 5];
    const result = deepMerge(base, override) as number[];
    expect(result).toEqual([4, 5]);
    expect(result).not.toBe(override);
  });
});

describe("deepMerge — full immutability (architect must-fix)", () => {
  // The architect review surfaced that the previous implementation shared
  // references to nested nodes with base. Phase C reload/swap depends on
  // prev-tree and next-tree being structurally independent — a mutation in
  // one must not bleed into the other. Deep-cloning every node is the
  // invariant.

  it("result.nested !== base.nested (reference-level detached)", () => {
    const base = { outer: { inner: { leaf: 1 } } };
    const override = { unrelated: 2 };
    const result = deepMerge(base, override) as { outer: { inner: unknown } };
    expect(result.outer).not.toBe(base.outer);
    expect(result.outer.inner).not.toBe(base.outer.inner);
  });

  it("result.array !== base.array when base-only", () => {
    const base = { plugins: ["a", "b"] };
    const override = { unrelated: 1 };
    const result = deepMerge(base, override) as Record<string, unknown>;
    expect(result.plugins).not.toBe(base.plugins);
    expect(result.plugins).toEqual(["a", "b"]);
  });

  it("result.array !== override.array when override-wins", () => {
    const base = { plugins: ["x"] };
    const override = { plugins: ["a", "b", "c"] };
    const result = deepMerge(base, override) as Record<string, unknown>;
    expect(result.plugins).not.toBe(override.plugins);
  });

  it("mutation on result does not leak into inputs", () => {
    const base = { nested: { a: 1 } };
    const override = { nested: { b: 2 } };
    const result = deepMerge(base, override) as { nested: { a?: number; b?: number } };
    result.nested.a = 999;
    result.nested.b = 999;
    expect(base.nested).toEqual({ a: 1 });
    expect(override.nested).toEqual({ b: 2 });
  });

  it("mutation on nested array in result does not leak", () => {
    const base = { tags: ["foo"] };
    const override = { unrelated: 1 };
    const result = deepMerge(base, override) as { tags: string[] };
    result.tags.push("bar");
    expect(base.tags).toEqual(["foo"]);
  });
});

describe("deepMerge — edge cases", () => {
  it("empty object + empty object = empty object", () => {
    expect(deepMerge({}, {})).toEqual({});
  });

  it("undefined keys in object are skipped", () => {
    // We write them as-is in the TS runtime — undefined keys are not
    // serialized into JSON; but if the value came in via YAML as an
    // explicit null, it would be null, not undefined.
    const base = { a: 1 } as Record<string, unknown>;
    const override = { b: undefined } as Record<string, unknown>;
    // Our implementation: undefined keys are silently dropped from override.
    // This matches JSON semantics (undefined is not a valid JSON value).
    expect(deepMerge(base as { a: number }, override as { b: number })).toEqual({ a: 1 });
  });
});

describe("deepMergeAll", () => {
  it("empty list → {}", () => {
    expect(deepMergeAll([])).toEqual({});
  });

  it("single layer → same tree", () => {
    expect(deepMergeAll([{ a: 1 }])).toEqual({ a: 1 });
  });

  it("three-layer merge (base → local → env)", () => {
    const base = { database: { name: "dev", pool_size: 20 }, cache: { ttl_min: 15 } };
    const local = { database: { name: "prod" } };
    const env = { cache: { ttl_min: 30 } };
    expect(deepMergeAll([base, local, env])).toEqual({
      database: { name: "prod", pool_size: 20 },
      cache: { ttl_min: 30 },
    });
  });

  it("later layers override earlier", () => {
    expect(deepMergeAll([{ x: 1 }, { x: 2 }, { x: 3 }])).toEqual({ x: 3 });
  });
});
