// ADR-0001 v2.1 §4.4: env-substituted strings are coerced to schema fields
// before zod validation. The walker uses the zod internal `_def.typeName`
// for type introspection. It is paired with the pre-validation reverse-case
// check (a native int/float/bool in a string field → ConfigError(TYPE_MISMATCH)
// inside the getSection wrapper).
//
// Required behavior: recognize ZodObject / ZodNumber / ZodBoolean / ZodOptional
// / ZodDefault / ZodNullable / ZodArray. Unknown types pass through.

import type { z } from "zod";

// Source-of-truth regexes from _meta/coercion.yaml (mirrors §4.3).
const INT_STRING_RE = /^-?\d+$/;
const NUMBER_STRING_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

interface ZodDef {
  typeName?: string;
  innerType?: z.ZodTypeAny;
  shape?: () => Record<string, z.ZodTypeAny>;
  type?: z.ZodTypeAny;
  checks?: readonly { kind?: string }[];
}

function getDef(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

/**
 * Walker: traverses `raw` guided by `schema` and converts env-substituted
 * numeric and boolean strings into native types. Unknown zod types are
 * passed through unchanged (zod itself will produce an idiomatic error
 * on validate).
 *
 * The reverse case (native non-string → string field) is **NOT** handled
 * here — it is rejected during post-processing of the zod
 * `ValidationError` inside getSection.
 */
export function coerceEnvStringsForSchema(raw: unknown, schema: z.ZodTypeAny): unknown {
  const def = getDef(schema);
  const typeName = def.typeName;

  // Unwrap optional / default / nullable — coerce against the inner type.
  if (typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodNullable") {
    if (raw === undefined || raw === null) return raw;
    const inner = def.innerType;
    return inner ? coerceEnvStringsForSchema(raw, inner) : raw;
  }

  if (typeName === "ZodObject") {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return raw;
    }
    const shapeGetter = def.shape;
    if (!shapeGetter) return raw;
    const shape = shapeGetter();
    const input = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(input)) {
      const sub = shape[k];
      out[k] = sub === undefined ? input[k] : coerceEnvStringsForSchema(input[k], sub);
    }
    return out;
  }

  if (typeName === "ZodArray") {
    if (!Array.isArray(raw)) return raw;
    const itemSchema = def.type;
    if (!itemSchema) return raw;
    return raw.map((item) => coerceEnvStringsForSchema(item, itemSchema));
  }

  if (typeName === "ZodNumber") {
    if (typeof raw !== "string") return raw;
    const wantsInt = (def.checks ?? []).some((c) => c.kind === "int");
    if (wantsInt) {
      if (INT_STRING_RE.test(raw)) {
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isNaN(parsed)) return parsed;
      }
      return raw;
    }
    if (NUMBER_STRING_RE.test(raw)) {
      const parsed = Number.parseFloat(raw);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return raw;
  }

  if (typeName === "ZodBoolean") {
    if (typeof raw !== "string") return raw;
    const lower = raw.toLowerCase();
    if (lower === "true" || lower === "yes" || lower === "1") return true;
    if (lower === "false" || lower === "no" || lower === "0") return false;
    return raw;
  }

  // ZodString / ZodLiteral / ZodEnum / ZodUnion / etc. — passthrough.
  return raw;
}
