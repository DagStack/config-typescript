import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize, type JsonValue } from "../src/canonical-json.js";
import { ConfigError } from "../src/errors.js";

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const KEY_ORDER_FIXTURE_PATH = resolve(
  __dirname_,
  "..",
  "spec",
  "conformance",
  "canonical_json",
  "key_order_drift_witness.json",
);

describe("canonicalize — primitives", () => {
  it("null", () => {
    expect(canonicalize(null)).toBe("null");
  });

  it("boolean", () => {
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
  });

  it("integer", () => {
    expect(canonicalize(0)).toBe("0");
    expect(canonicalize(1)).toBe("1");
    expect(canonicalize(-42)).toBe("-42");
    expect(canonicalize(9007199254740991)).toBe("9007199254740991"); // 2^53 - 1
    expect(canonicalize(-9007199254740991)).toBe("-9007199254740991");
  });

  it("negative zero → 0", () => {
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(0)).toBe("0");
  });

  it("float shortest round-trip", () => {
    expect(canonicalize(0.1)).toBe("0.1");
    expect(canonicalize(0.5)).toBe("0.5");
    expect(canonicalize(-3.14)).toBe("-3.14");
    expect(canonicalize(1e10)).toBe("10000000000");
  });

  it("rejects NaN", () => {
    expect(() => canonicalize(NaN)).toThrow(ConfigError);
    expect(() => canonicalize(NaN)).toThrow(/NaN/);
  });

  it("rejects Infinity", () => {
    expect(() => canonicalize(Infinity)).toThrow(ConfigError);
    expect(() => canonicalize(-Infinity)).toThrow(/Infinity/);
  });

  it("string — minimal escape", () => {
    expect(canonicalize("")).toBe('""');
    expect(canonicalize("hello")).toBe('"hello"');
    expect(canonicalize('quote"inside')).toBe('"quote\\"inside"');
    expect(canonicalize("back\\slash")).toBe('"back\\\\slash"');
    expect(canonicalize("tab\there")).toBe('"tab\\there"');
    expect(canonicalize("newline\nhere")).toBe('"newline\\nhere"');
  });

  it("string — control chars escaped as \\uXXXX", () => {
    expect(canonicalize("\x00")).toBe('"\\u0000"');
    expect(canonicalize("\x1f")).toBe('"\\u001f"');
  });

  it("string — Unicode > 0x1F passthrough", () => {
    expect(canonicalize("привет")).toBe('"привет"');
    expect(canonicalize("日本語")).toBe('"日本語"');
    expect(canonicalize("emoji💡")).toBe('"emoji💡"');
  });
});

describe("canonicalize — containers", () => {
  it("empty array", () => {
    expect(canonicalize([])).toBe("[]");
  });

  it("empty object", () => {
    expect(canonicalize({})).toBe("{}");
  });

  it("array of primitives", () => {
    expect(canonicalize([1, 2, 3])).toBe("[1,2,3]");
    expect(canonicalize([true, false, null])).toBe("[true,false,null]");
    expect(canonicalize(["a", "b"])).toBe('["a","b"]');
  });

  it("object — keys sorted lexicographically", () => {
    expect(canonicalize({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
    expect(canonicalize({ zebra: 1, apple: 2 })).toBe('{"apple":2,"zebra":1}');
  });

  it("object — sort is UTF-8 code-point order", () => {
    // Unicode code points: "A"=0x41, "B"=0x42, "a"=0x61, "z"=0x7A,
    // Cyrillic "а"=0x430. Capital before lowercase, ASCII before Cyrillic.
    expect(canonicalize({ z: 0, A: 0, а: 0, a: 0 })).toBe('{"A":0,"a":0,"z":0,"а":0}');
  });

  it("no whitespace between/around tokens", () => {
    expect(canonicalize({ nested: { arr: [1, 2] } })).toBe('{"nested":{"arr":[1,2]}}');
  });

  it("nested object + array — deep ordering", () => {
    const input = {
      cache: { ttl_min: 30, max_size_mb: 64 },
      database: { name: "prod", password: "secret" },
    };
    expect(canonicalize(input)).toBe(
      '{"cache":{"max_size_mb":64,"ttl_min":30},"database":{"name":"prod","password":"secret"}}',
    );
  });

  it("no trailing newline", () => {
    const out = canonicalize({ a: 1 });
    expect(out.endsWith("\n")).toBe(false);
    expect(out).toBe('{"a":1}');
  });
});

describe("canonicalize — matches spec/conformance/expected/*.json", () => {
  it("basic_interpolation expected", () => {
    // Reproduce spec/conformance/expected/basic_interpolation.json.
    const input = {
      cache: {
        max_size_mb: 64,
        ttl_min: 30,
      },
      database: {
        host: "db.local",
        name: "prod",
        password: "secret-123",
      },
    };
    expect(canonicalize(input)).toBe(
      '{"cache":{"max_size_mb":64,"ttl_min":30},"database":{"host":"db.local","name":"prod","password":"secret-123"}}',
    );
  });

  it("layered expected", () => {
    const input = {
      cache: { max_size_mb: 64, ttl_min: 30 },
      database: { name: "prod", pool_size: 30, timeout_ms: 4096 },
      plugins: ["chunker"],
    };
    expect(canonicalize(input)).toBe(
      '{"cache":{"max_size_mb":64,"ttl_min":30},"database":{"name":"prod","pool_size":30,"timeout_ms":4096},"plugins":["chunker"]}',
    );
  });
});

describe("canonicalize — UTF-16 code-unit sort (RFC 8785 §3.2.3)", () => {
  // RFC 8785 §3.2.3 mandates that object members be sorted by their UTF-16
  // code-unit sequence. `Array.prototype.sort()` without a comparator is
  // already UTF-16 code-unit order per ECMA-262 §22.1.3.27, so the language
  // default is the conformant choice — earlier versions of this binding
  // supplied an explicit `compareUtf8Bytes` comparator (in pursuit of the
  // then-non-conformant Python/Go parity) which is now removed.
  //
  // These tests guard against a regression back to either UTF-8 or UTF-32
  // sort orders.

  it("sort by UTF-16 code units for BMP keys", () => {
    // Latin vs Cyrillic. "z"=U+007A, "а"=U+0430. UTF-16 (and code-point)
    // order: z < а (ASCII < Cyrillic).
    expect(canonicalize({ а: 0, z: 0 })).toBe('{"z":0,"а":0}');
  });

  it("BMP-PUA vs supplementary key — drift-witness fixture case", () => {
    // The single fixture case that distinguishes the three flavours of
    // sort order on a single pair of keys. Mirrors
    // spec/conformance/canonical_json/key_order_drift_witness.json
    // → drift_witness_pua_vs_supplementary.
    //   - "" = U+E000 (BMP private-use area, single code unit).
    //   - "𠀀"     = U+20000 (supplementary; UTF-16 surrogate pair
    //     0xD840 0xDC00).
    // UTF-16 code-unit order (RFC 8785, JS native): 0xD840 < 0xE000
    //   → supplementary key first.
    // UTF-32 code-point order (Python sorted()):   0xE000 < 0x20000
    //   → BMP-PUA key first.
    // UTF-8 byte order (Go sort.Strings):          EE 80 80 <
    //   F0 A0 80 80 → BMP-PUA key first.
    const result = canonicalize({ "": 1, "\u{20000}": 2 });
    expect(result).toBe('{"\u{20000}":2,"":1}');
  });

  it("sort stable for mixed BMP + supplementary keys", () => {
    // "a"=U+0061, "€"=U+20AC (BMP), "😀"=U+1F600 (supplementary,
    // surrogate pair 0xD83D 0xDE00). UTF-16 code-unit order:
    //   "a"   → [0x0061]
    //   "€"   → [0x20AC]
    //   "😀" → [0xD83D, 0xDE00]
    // 0x0061 < 0x20AC < 0xD83D → a, €, 😀 — the same order as code-point
    // order in this case (both ascending), but pinned here as a
    // regression guard.
    expect(canonicalize({ "😀": 3, "€": 2, a: 1 })).toBe('{"a":1,"€":2,"😀":3}');
  });
});

describe("canonicalize — float format (known cross-binding divergence)", () => {
  // JS and Python diverge in the exponential notation for floats outside
  // the "normal" range. This is a known spec gap (see the inline comment
  // in `src/canonical-json.ts`), not pending work — so instead of `.todo`
  // we just regression-guard the current JS behavior. Until an ADR
  // amendment lands in config-spec we do not include extreme floats in
  // conformance fixtures.

  it("current JS behavior (regress-guard, not cross-binding promise)", () => {
    // Do not change these expectations without an ADR amendment in
    // config-spec — these are deliberate JS-native values.
    //
    // Python emits `1e-7 → "1e-07"`, `1e20 → "1e+20"`; we stay JS-native
    // until cross-binding resolution lands in the spec.
    expect(canonicalize(1e-7)).toBe("1e-7");
    expect(canonicalize(1e20)).toBe("100000000000000000000");
    expect(canonicalize(1e-6)).toBe("0.000001");
  });
});

interface KeyOrderCase {
  readonly name: string;
  readonly description: string;
  readonly input: JsonValue;
  readonly expected_wire: string;
}

interface KeyOrderFixture {
  readonly cases: readonly KeyOrderCase[];
}

const keyOrderFixture: KeyOrderFixture | null = existsSync(KEY_ORDER_FIXTURE_PATH)
  ? (JSON.parse(readFileSync(KEY_ORDER_FIXTURE_PATH, "utf-8")) as KeyOrderFixture)
  : null;

// Cases known to have an authoring bug in the upstream fixture; tracked
// in config-spec issue #31 and patched in config-spec PR #32. The
// conformant wire bytes for these cases are pinned by the inline
// regression tests above ("BMP-PUA vs supplementary key — drift-witness
// fixture case"), so the binding still verifies the correct behaviour
// without depending on the fixture's current bytes.
const FIXTURE_AUTHORING_BUGS: ReadonlySet<string> = new Set([
  "drift_witness_pua_vs_supplementary",
]);

describe.skipIf(keyOrderFixture === null)(
  "canonicalize — cross-binding key-order conformance fixture",
  () => {
    // The fixture lives at spec/conformance/canonical_json/
    // key_order_drift_witness.json and is normative under
    // _meta/canonical_json.yaml v1.1. Skipped when the `spec` submodule
    // has not been initialised (`git submodule update --init`).
    for (const c of keyOrderFixture!.cases) {
      it.skipIf(FIXTURE_AUTHORING_BUGS.has(c.name))(c.name, () => {
        expect(canonicalize(c.input)).toBe(c.expected_wire);
      });
    }
  },
);

describe("canonicalize — edge cases", () => {
  it("rejects undefined in object", () => {
    const withUndefined = { a: 1, b: undefined } as unknown as Record<string, null>;
    expect(() => canonicalize(withUndefined)).toThrow(ConfigError);
    expect(() => canonicalize(withUndefined)).toThrow(/undefined/);
  });

  it("error path tracks nested location", () => {
    try {
      canonicalize({ outer: { inner: NaN } });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      expect(err.path).toBe("outer.inner");
    }
  });

  it("error path tracks array index", () => {
    try {
      canonicalize([1, 2, NaN]);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as ConfigError).path).toBe("[2]");
    }
  });
});
