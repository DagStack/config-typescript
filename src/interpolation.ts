// Env interpolation: ${VAR} / ${VAR:-default} / $$ escape.
//
// ADR-0001 §2 + an architectural recommendation — a scanner-state parser,
// not a regex with lookbehind (so it ports cleanly to Go RE2, which has
// no lookbehind).
//
// Grammar (EBNF):
//   text         = ( literal | escaped | placeholder )*
//   literal      = any character other than `$`
//   escaped      = "$$"                                 // → literal `$`
//   placeholder  = "${" ident [ ":-" default_value ] "}"
//   ident        = [A-Za-z_][A-Za-z0-9_]*
//   default_value= any characters, including spaces and colons,
//                  but neither `${` (nested placeholders are forbidden)
//                  nor `}`
//
// Semantics (POSIX-style, per ADR §2):
//   - `${VAR}`              — value from env; if unset → ENV_UNRESOLVED.
//   - `${VAR:-default}`     — value from env if set and non-empty;
//                             otherwise the literal "default".
//   - Empty env var VAR=""  — `${VAR:-default}` falls back to default
//                             (covered by unit fixtures).
//   - Nested `${${...}}`    — PARSE_ERROR. Nesting via $-references is
//                             not supported, to avoid ambiguity.

import { ConfigError, ConfigErrorReason } from "./errors.js";

export type EnvMap = Readonly<Record<string, string | undefined>>;

const IDENT_START = /[A-Za-z_]/;
const IDENT_CONT = /[A-Za-z0-9_]/;

/**
 * Resolves all ${VAR} / ${VAR:-default} / $$ in text using env.
 *
 * @param path — dot-notation path inside the config (for ConfigError). Pass
 *               an empty string when the path is unknown (raw-string call).
 */
export function interpolate(text: string, env: EnvMap, path = ""): string {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text.charAt(i);

    if (ch !== "$") {
      // Literal — copy in bulk up to the next `$`.
      const next = text.indexOf("$", i);
      if (next === -1) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, next);
      i = next;
      continue;
    }

    // ch === "$"; look at the next character (charAt returns "" past the end).
    const nextCh = text.charAt(i + 1);

    if (nextCh === "$") {
      // Escape: $$ → $.
      out += "$";
      i += 2;
      continue;
    }

    if (nextCh === "{") {
      // Placeholder: ${ ident [:-default] }
      const result = readPlaceholder(text, i, env, path);
      out += result.value;
      i = result.endIndex;
      continue;
    }

    // A standalone `$` without a following `{` or `$` is a literal `$`.
    // Consistent with bash / POSIX shell: `echo $` prints `$`.
    out += "$";
    i += 1;
  }

  return out;
}

interface PlaceholderResult {
  readonly value: string;
  readonly endIndex: number; // index of the character after the closing `}`.
}

function readPlaceholder(
  text: string,
  start: number, // index of `$`
  env: EnvMap,
  path: string,
): PlaceholderResult {
  // text[start] === '$', text[start+1] === '{'
  let i = start + 2;
  const n = text.length;

  // ADR-0002 §1: `${secret:<scheme>:<path>...}` tokens are reserved
  // for the Phase 2 SecretSource path. They are emitted verbatim by
  // this function so the post-YAML tree walker (`secret-grammar.walkSecretRefs`)
  // can convert them to `SecretRef` placeholders. The Phase 1 env
  // interpolator deliberately does not interpret them.
  if (text.startsWith("secret:", i)) {
    const close = text.indexOf("}", i);
    if (close === -1) {
      throw parseError(text, start, path, "unclosed '${secret:' at end of input");
    }
    return { value: text.slice(start, close + 1), endIndex: close + 1 };
  }

  // 1. Read ident. charAt returns "" beyond the string boundary, which is
  // convenient: IDENT_START.test("") === false, so no explicit bounds check.
  if (i >= n) {
    throw parseError(text, start, path, "unclosed '${' at end of input");
  }
  const identStart = i;
  const firstCh = text.charAt(i);
  if (!IDENT_START.test(firstCh)) {
    // Detect nested ${${...}} so we can produce a friendly error.
    if (firstCh === "$") {
      throw parseError(text, start, path, "nested '${...}' is not supported");
    }
    throw parseError(
      text,
      start,
      path,
      `invalid env variable name (expected [A-Za-z_], got '${firstCh}')`,
    );
  }
  i++;
  while (i < n && IDENT_CONT.test(text.charAt(i))) {
    i++;
  }
  const ident = text.slice(identStart, i);

  if (i >= n) {
    throw parseError(text, start, path, `unclosed '\${${ident}' at end of input`);
  }

  // 2. Optional :-default.
  let defaultValue: string | undefined;
  if (text.charAt(i) === ":" && text.charAt(i + 1) === "-") {
    i += 2;
    const defStart = i;
    // Read up to the closing `}`. A nested `${` inside the default is a
    // PARSE_ERROR (ADR §2 says "nested ${…} inside defaults is not
    // interpolated", and the architect's brief also says "Nested ${${...}}
    // is an explicit reject with an error code"; we choose phased
    // strictness: a default cannot contain `${` at all, removing ambiguity).
    while (i < n && text.charAt(i) !== "}") {
      if (text.charAt(i) === "$" && text.charAt(i + 1) === "{") {
        throw parseError(text, start, path, "nested '${...}' inside default is not supported");
      }
      i++;
    }
    if (i >= n) {
      throw parseError(text, start, path, `unclosed '\${${ident}:-' at end of input`);
    }
    defaultValue = text.slice(defStart, i);
  }

  // 3. Closing `}`.
  if (text.charAt(i) !== "}") {
    const seen = i < n ? text.charAt(i) : "EOF";
    throw parseError(
      text,
      start,
      path,
      `unexpected '${seen}' in '\${${ident}' — expected '}' or ':-default'`,
    );
  }
  const endIndex = i + 1;

  // 4. Resolve.
  const raw = env[ident];
  const hasValue = raw !== undefined && raw !== "";
  if (hasValue) {
    return { value: raw, endIndex };
  }
  if (defaultValue !== undefined) {
    return { value: defaultValue, endIndex };
  }
  throw new ConfigError({
    path,
    reason: ConfigErrorReason.ENV_UNRESOLVED,
    details: `environment variable '${ident}' is not set and no default provided`,
  });
}

function parseError(text: string, position: number, path: string, message: string): ConfigError {
  const snippet = text.slice(Math.max(0, position - 10), Math.min(text.length, position + 30));
  return new ConfigError({
    path,
    reason: ConfigErrorReason.PARSE_ERROR,
    details: `${message} (near '${snippet}' at offset ${position.toString()})`,
  });
}
