import { describe, expect, it } from "vitest";

import { ConfigError, ConfigErrorReason } from "../src/errors.js";
import { interpolate } from "../src/interpolation.js";

describe("interpolate — literal passthrough", () => {
  it("empty string", () => {
    expect(interpolate("", {})).toBe("");
  });

  it("no placeholders", () => {
    expect(interpolate("just text", {})).toBe("just text");
  });

  it("special characters without $", () => {
    expect(interpolate("{}[]\\/|", {})).toBe("{}[]\\/|");
  });

  it("lone $ at end is literal", () => {
    expect(interpolate("trailing $", {})).toBe("trailing $");
  });

  it("lone $ mid-string is literal", () => {
    expect(interpolate("mid $ string", {})).toBe("mid $ string");
  });
});

describe("interpolate — $$ escape", () => {
  it("single $$ at start", () => {
    expect(interpolate("$$var", {})).toBe("$var");
  });

  it("$$ at end", () => {
    expect(interpolate("text$$", {})).toBe("text$");
  });

  it("$$ between placeholders", () => {
    expect(interpolate("${A}$$${B}", { A: "x", B: "y" })).toBe("x$y");
  });

  it("multiple $$ in row", () => {
    expect(interpolate("$$$$", {})).toBe("$$");
    expect(interpolate("$$$$$$", {})).toBe("$$$");
  });
});

describe("interpolate — ${VAR} resolution", () => {
  it("simple substitution", () => {
    expect(interpolate("${FOO}", { FOO: "bar" })).toBe("bar");
  });

  it("multiple substitutions", () => {
    expect(interpolate("${A}-${B}-${C}", { A: "1", B: "2", C: "3" })).toBe("1-2-3");
  });

  it("substitution surrounded by text", () => {
    expect(interpolate("url://${HOST}:${PORT}/path", { HOST: "localhost", PORT: "8080" })).toBe(
      "url://localhost:8080/path",
    );
  });

  it("throws ENV_UNRESOLVED when unset", () => {
    expect(() => interpolate("${MISSING}", {})).toThrow(ConfigError);
    try {
      interpolate("${MISSING}", {});
      expect.fail();
    } catch (e) {
      const err = e as ConfigError;
      expect(err.reason).toBe(ConfigErrorReason.ENV_UNRESOLVED);
      expect(err.details).toContain("MISSING");
    }
  });

  it("throws when VAR='' (POSIX-style) and no default", () => {
    // ADR §2: "not set or empty" → both trigger ENV_UNRESOLVED when no
    // default. Empty env var is semantically equivalent to unset here.
    expect(() => interpolate("${EMPTY}", { EMPTY: "" })).toThrow(ConfigError);
  });
});

describe("interpolate — ${VAR:-default}", () => {
  it("uses default when VAR unset", () => {
    expect(interpolate("${FOO:-fallback}", {})).toBe("fallback");
  });

  it("uses default when VAR empty (POSIX :-)", () => {
    expect(interpolate("${FOO:-fallback}", { FOO: "" })).toBe("fallback");
  });

  it("uses VAR value when set and non-empty", () => {
    expect(interpolate("${FOO:-fallback}", { FOO: "actual" })).toBe("actual");
  });

  it("default may be empty string", () => {
    expect(interpolate("${FOO:-}", {})).toBe("");
    expect(interpolate("before${FOO:-}after", {})).toBe("beforeafter");
  });

  it("default may contain spaces", () => {
    expect(interpolate("${FOO:-with spaces}", {})).toBe("with spaces");
  });

  it("default may contain colons", () => {
    expect(interpolate("${FOO:-http://localhost:11434/v1}", {})).toBe("http://localhost:11434/v1");
  });

  it("default may contain special chars (except ${ and })", () => {
    expect(interpolate("${FOO:-a/b\\c|d}", {})).toBe("a/b\\c|d");
  });
});

describe("interpolate — nested ${${...}} → PARSE_ERROR", () => {
  it("rejects nested placeholder in identifier position", () => {
    expect(() => interpolate("${${FOO}}", { FOO: "BAR", BAR: "x" })).toThrow(ConfigError);
    try {
      interpolate("${${FOO}}", { FOO: "BAR" });
      expect.fail();
    } catch (e) {
      expect((e as ConfigError).reason).toBe(ConfigErrorReason.PARSE_ERROR);
      expect((e as ConfigError).details).toMatch(/nested/);
    }
  });

  it("rejects nested placeholder in default value", () => {
    expect(() => interpolate("${A:-${B}}", { B: "x" })).toThrow(ConfigError);
    try {
      interpolate("${A:-${B}}", { B: "x" });
      expect.fail();
    } catch (e) {
      expect((e as ConfigError).reason).toBe(ConfigErrorReason.PARSE_ERROR);
    }
  });
});

describe("interpolate — parse errors", () => {
  it("unclosed ${", () => {
    expect(() => interpolate("${FOO", {})).toThrow(/unclosed/);
  });

  it("unclosed ${ with partial ident and colon-dash", () => {
    expect(() => interpolate("${FOO:-", {})).toThrow(/unclosed/);
  });

  it("invalid ident starting with digit", () => {
    expect(() => interpolate("${9BAD}", { "9BAD": "x" })).toThrow(ConfigError);
  });

  it("ident must start with letter or underscore", () => {
    expect(() => interpolate("${-BAD}", {})).toThrow(ConfigError);
    expect(interpolate("${_GOOD}", { _GOOD: "ok" })).toBe("ok");
  });

  it("empty placeholder ${}", () => {
    expect(() => interpolate("${}", {})).toThrow(ConfigError);
  });
});

describe("interpolate — path propagation", () => {
  it("ConfigError.path set to provided path", () => {
    try {
      interpolate("${MISSING}", {}, "database.password");
      expect.fail();
    } catch (e) {
      expect((e as ConfigError).path).toBe("database.password");
    }
  });

  it("empty path is fine for raw string calls", () => {
    try {
      interpolate("${MISSING}", {});
      expect.fail();
    } catch (e) {
      expect((e as ConfigError).path).toBe("");
    }
  });
});

describe("interpolate — complex real-world examples", () => {
  it("matches spec/conformance/inputs/basic_interpolation.yaml leafs", () => {
    const env = {
      DB_PASSWORD: "secret-123",
      DB_NAME: "prod",
      CACHE_TTL_MIN: "30",
    };
    expect(interpolate("${DB_HOST:-db.local}", env)).toBe("db.local");
    expect(interpolate("${DB_PASSWORD}", env)).toBe("secret-123");
    expect(interpolate("${DB_NAME:-default}", env)).toBe("prod");
    expect(interpolate("${CACHE_TTL_MIN:-15}", env)).toBe("30");
    expect(interpolate("${CACHE_MAX_SIZE_MB:-64}", env)).toBe("64");
  });

  it("PostgreSQL URL with multiple substitutions", () => {
    const env = { DB_USER: "admin", DB_HOST: "db.prod" };
    expect(
      interpolate("postgresql://${DB_USER}:${DB_PASS:-changeme}@${DB_HOST}/${DB_NAME:-myapp}", env),
    ).toBe("postgresql://admin:changeme@db.prod/myapp");
  });

  it("escaped $ before placeholder", () => {
    expect(interpolate("$$${PATH}", { PATH: "/usr/bin" })).toBe("$/usr/bin");
  });
});
