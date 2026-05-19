// Common types for the config-tree representation.
//
// ConfigValue is a narrow subtype of JSON: null / boolean / number / string /
// array / plain object. Sources (YAML / JSON / InMemory) materialize into this
// type; `canonicalize`, `deepMerge`, and `getByPath` operate on top of it.
//
// Historically the codebase had two names (`ConfigValue` for merge,
// `JsonValue` for canonical-json) — they are now unified via an alias so we
// avoid type mismatches in Phase C when `Config.get()` returns a sub-section
// and we pass it into `canonicalize`.

export type ConfigValue =
  | null
  | boolean
  | number
  | string
  | ConfigValue[]
  | { [key: string]: ConfigValue };

// Semantic aliases — same runtime type, the name signals the role.
export type ConfigTree = ConfigValue;
export type JsonValue = ConfigValue;
