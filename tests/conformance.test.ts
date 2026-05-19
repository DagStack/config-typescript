// Conformance runner — a data-driven test driven by spec/conformance/manifest.yaml.
//
// Reads the manifest (`version: "1.0"`); for each test:
//   - happy path: load the sources, canonicalize, byte-identical diff
//     against `expected/*.json`.
//   - error case: check `reason` (exact match) and `path` (exact match,
//     empty allowed).
//
// The runner honors the `runner.md` contract: `env: null` means an empty
// env (the developer's process env does not leak), and expected files may
// have a trailing \n — it is trimmed. The whole run is skipped if the
// submodule is not initialised (git submodule update --init for local dev).

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import type { ConfigError, ConfigErrorReason } from "../src/index.js";
import {
  Config,
  EnvSecretSource,
  VaultSource,
  YamlFileSource,
  canonicalize,
  isConfigError,
} from "../src/index.js";
import type { EnvMap } from "../src/interpolation.js";

interface Manifest {
  version: string;
  tests: ConformanceCase[];
}

interface ConformanceCase {
  id: string;
  description: string;
  tags?: string[];
  inputs: string[];
  env: string | null;
  expected?: string;
  expected_error?: {
    reason: string;
    path: string;
    source_id_pattern?: string;
  };
}

const SPEC_DIR = "spec/conformance";
const MANIFEST_PATH = join(SPEC_DIR, "manifest.yaml");

function loadManifest(): Manifest | null {
  if (!existsSync(MANIFEST_PATH)) return null;
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  return YAML.parse(raw) as Manifest;
}

function loadEnvFile(relPath: string | null): EnvMap {
  // The `runner.md` contract: `env: null` means an "empty env" — the
  // developer's variables (HOME, PATH, etc.) do not leak through.
  if (relPath === null) return {};
  const raw = readFileSync(join(SPEC_DIR, relPath), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return env;
}

const manifest = loadManifest();

describe("conformance runner", () => {
  beforeAll(() => {
    if (manifest === null) {
      // Submodule is not initialised — the test will skip below via it.skip.
      return;
    }
    expect(manifest.version).toBe("1.0");
  });

  if (manifest === null) {
    it.skip("spec/conformance/ submodule not initialised (git submodule update --init)", () => {
      // placeholder so the test runner produces an explicit message.
    });
    return;
  }

  for (const tc of manifest.tests) {
    // v2.1 fixtures require getter/getSection-level calls that the v1.0
    // runner does not model (it only handles load-level). Binding-native
    // tests cover these scenarios directly (see tests/config.test.ts and
    // tests/docs_examples/reference_errors.test.ts).
    const tags = tc.tags ?? [];
    const requiresRunnerExtension = tags.includes("runner_extension_required");
    // ADR-0002 phase2_secrets_vault — gated on a live Vault dev server.
    const requiresVault = tags.includes("phase2_secrets_vault");
    const skipForVault = requiresVault && !process.env.DAGSTACK_CONFORMANCE_VAULT_ADDR;
    const runner = requiresRunnerExtension || skipForVault ? it.skip : it;

    runner(tc.id, async () => {
      const env = loadEnvFile(tc.env);
      const sources: (YamlFileSource | EnvSecretSource)[] = tc.inputs.map(
        (rel) => new YamlFileSource(join(SPEC_DIR, rel), { env }),
      );

      // ADR-0002 phase2_secrets — feed the EnvSecretSource (the `env`
      // scheme) from the fixture's env vector, NOT from process.env.
      if (tags.includes("phase2_secrets")) {
        sources.push(
          new EnvSecretSource({ lookup: (name: string): string | undefined => env[name] }),
        );
      }
      // ADR-0002 phase2_secrets_vault — connect to the dev-mode Vault
      // seeded by spec/conformance/vault/seed.sh.
      if (tags.includes("phase2_secrets_vault")) {
        const vaultAddr = process.env.DAGSTACK_CONFORMANCE_VAULT_ADDR;
        if (vaultAddr === undefined) throw new Error("DAGSTACK_CONFORMANCE_VAULT_ADDR not set");
        const vaultToken = process.env.DAGSTACK_CONFORMANCE_VAULT_TOKEN ?? "conformance-root-token";
        sources.push(
          new VaultSource({
            addr: vaultAddr,
            auth: { kind: "token", token: vaultToken },
          }),
        );
      }

      if (tc.expected_error !== undefined) {
        try {
          await Config.loadFrom(sources);
          expect.fail(`expected error with reason=${tc.expected_error.reason}`);
        } catch (err) {
          expect(isConfigError(err)).toBe(true);
          const cfgErr = err as ConfigError;
          expect(cfgErr.reason).toBe(tc.expected_error.reason as ConfigErrorReason);
          expect(cfgErr.path).toBe(tc.expected_error.path);
          if (tc.expected_error.source_id_pattern !== undefined && cfgErr.sourceId !== undefined) {
            expect(cfgErr.sourceId).toContain(tc.expected_error.source_id_pattern);
          }
        }
        return;
      }

      // Happy path: canonicalize the raw resolved tree → diff
      // byte-identical. We reach into the internal `tree` field
      // because `snapshot()` applies field-name suffix masking
      // (ADR-0002 §3 trigger table) which would mangle the
      // verbatim conformance comparison. Test-internal use only —
      // external consumers should call `snapshot()` and accept the
      // masking semantics it documents.
      const cfg = await Config.loadFrom(sources);
      const rawTree = (cfg as unknown as { tree: unknown }).tree;
      const actual = canonicalize(rawTree as Parameters<typeof canonicalize>[0]);

      if (tc.expected === undefined) {
        expect.fail(`test '${tc.id}' missing both 'expected' and 'expected_error'`);
      }
      const expectedPath = join(SPEC_DIR, tc.expected);
      let expected = readFileSync(expectedPath, "utf8");
      // Expected fixtures per §9.1.1 have no trailing newline, but editors
      // may add a \n on save; we trim for tolerance.
      expected = expected.replace(/\n+$/, "");

      expect(actual).toBe(expected);
    });
  }
});

// Assert that the spec submodule actually contains the expected fixtures,
// so an accidentally broken checkout does not pass silently as a skip.
describe("conformance — submodule sanity", () => {
  it("spec/conformance/manifest.yaml exists OR the submodule is intentionally skipped", () => {
    if (!existsSync(MANIFEST_PATH)) {
      // Not a fail: local dev without the submodule is allowed. We log a
      // warning to stdout instead.
      console.warn(
        "spec/conformance/ submodule not initialised; run `git submodule update --init`",
      );
      return;
    }
    const stat = statSync(MANIFEST_PATH);
    expect(stat.size).toBeGreaterThan(0);
  });
});
