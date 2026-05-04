import { describe, expect, it, vi } from "vitest";

import { Config, ConfigError, ConfigErrorReason, InMemorySource } from "../src/index.js";
import { parseVaultPath, VaultSource } from "../src/vault.js";

// ── Path parser ───────────────────────────────────────────────────────

describe("parseVaultPath", () => {
  it("minimal path", () => {
    expect(parseVaultPath("secret/db")).toEqual({
      mountPoint: "secret",
      keyPath: "db",
      version: undefined,
      field: undefined,
    });
  });

  it("with subkey", () => {
    expect(parseVaultPath("secret/db#password")).toEqual({
      mountPoint: "secret",
      keyPath: "db",
      version: undefined,
      field: "password",
    });
  });

  it("with version", () => {
    expect(parseVaultPath("secret/db?version=3")).toEqual({
      mountPoint: "secret",
      keyPath: "db",
      version: 3,
      field: undefined,
    });
  });

  it("version + subkey", () => {
    expect(parseVaultPath("secret/dagstack/prod/db?version=5#password")).toEqual({
      mountPoint: "secret",
      keyPath: "dagstack/prod/db",
      version: 5,
      field: "password",
    });
  });

  it("missing mount-point segment raises", () => {
    expect(() => parseVaultPath("just-a-path")).toThrow(ConfigError);
  });

  it("invalid version raises", () => {
    expect(() => parseVaultPath("secret/db?version=latest")).toThrow(ConfigError);
  });

  it("unknown query key raises", () => {
    expect(() => parseVaultPath("secret/db?colour=red")).toThrow(ConfigError);
  });
});

// ── VaultSource via mocked node-vault ─────────────────────────────────

vi.mock("node-vault", () => {
  return {
    default: vi.fn(),
  };
});

import vaultModule from "node-vault";

const vaultFactory = vi.mocked(vaultModule);

interface MockClient {
  token?: string;
  read: ReturnType<typeof vi.fn>;
  approleLogin: ReturnType<typeof vi.fn>;
  kubernetesLogin: ReturnType<typeof vi.fn>;
}

function buildClient(secretData: Record<string, unknown>): MockClient {
  return {
    read: vi.fn().mockResolvedValue({
      data: { data: secretData, metadata: { version: 7 } },
    }),
    approleLogin: vi.fn().mockResolvedValue({
      auth: { client_token: "s.from-approle" },
    }),
    kubernetesLogin: vi.fn().mockResolvedValue({
      auth: { client_token: "s.from-k8s" },
    }),
  };
}

describe("VaultSource — Token auth + KV v2", () => {
  it("resolves single-key envelope via token auth", async () => {
    const client = buildClient({ value: "sk-from-vault" });
    vaultFactory.mockReturnValue(client);

    const src = new VaultSource({
      addr: "https://vault.example.com",
      auth: { kind: "token", token: "s.test" },
    });
    const result = await src.resolve("secret/openai", { attempt: 1 });
    expect(result.value).toBe("sk-from-vault");
    expect(client.read).toHaveBeenCalledWith("secret/data/openai");
  });

  it("applies #field projection on multi-key secret", async () => {
    const client = buildClient({ username: "u", password: "p" });
    vaultFactory.mockReturnValue(client);
    const src = new VaultSource({
      addr: "https://vault.example.com",
      auth: { kind: "token", token: "s.x" },
    });
    const result = await src.resolve("secret/db#password", { attempt: 1 });
    expect(result.value).toBe("p");
  });

  it("raises normative §1.2 message for multi-key without #field", async () => {
    const client = buildClient({ username: "u", password: "p" });
    vaultFactory.mockReturnValue(client);
    const src = new VaultSource({
      addr: "https://vault.example.com",
      auth: { kind: "token", token: "s.x" },
    });
    await expect(src.resolve("secret/db", { attempt: 1 })).rejects.toMatchObject({
      reason: ConfigErrorReason.SECRET_UNRESOLVED,
      details: expect.stringContaining(
        "reference resolved to object; specify a sub-key with '#field'",
      ) as unknown,
    });
  });

  it("raises for unknown #field", async () => {
    const client = buildClient({ username: "u", password: "p" });
    vaultFactory.mockReturnValue(client);
    const src = new VaultSource({
      addr: "https://vault.example.com",
      auth: { kind: "token", token: "s.x" },
    });
    await expect(src.resolve("secret/db#missing", { attempt: 1 })).rejects.toMatchObject({
      reason: ConfigErrorReason.SECRET_UNRESOLVED,
      details: expect.stringContaining('no field "missing"') as unknown,
    });
  });

  it("?version=N rewrites Vault HTTP path", async () => {
    const client = buildClient({ value: "v3" });
    vaultFactory.mockReturnValue(client);
    const src = new VaultSource({
      addr: "https://vault.example.com",
      auth: { kind: "token", token: "s.x" },
    });
    await src.resolve("secret/db?version=3", { attempt: 1 });
    expect(client.read).toHaveBeenCalledWith("secret/data/db?version=3");
  });

  it("namespace appended to id", () => {
    vaultFactory.mockReturnValue(buildClient({}));
    const src = new VaultSource({
      addr: "https://vault.example.com",
      auth: { kind: "token", token: "s.x" },
      namespace: "dagstack/prod",
    });
    expect(src.id).toBe("vault:https://vault.example.com?namespace=dagstack/prod");
  });
});

describe("VaultSource — Auth dispatch", () => {
  it("AppRole login uses provided role/secret", async () => {
    const client = buildClient({ value: "x" });
    vaultFactory.mockReturnValue(client);
    const src = new VaultSource({
      addr: "https://vault.example.com",
      auth: { kind: "approle", roleId: "role-x", secretId: "sec-y" },
    });
    await src.resolve("secret/foo", { attempt: 1 });
    expect(client.approleLogin).toHaveBeenCalledWith({
      role_id: "role-x",
      secret_id: "sec-y",
      mount_point: "approle",
    });
    expect(client.token).toBe("s.from-approle");
  });

  it("AppRole 403 maps to PERMISSION_DENIED", async () => {
    const client = buildClient({ value: "x" });
    const err: Error & { response?: { statusCode?: number } } = new Error("forbidden");
    err.response = { statusCode: 403 };
    client.approleLogin = vi.fn().mockRejectedValue(err);
    vaultFactory.mockReturnValue(client);
    const src = new VaultSource({
      addr: "https://vault.example.com",
      auth: { kind: "approle", roleId: "bad", secretId: "bad" },
    });
    await expect(src.resolve("secret/x", { attempt: 1 })).rejects.toMatchObject({
      reason: ConfigErrorReason.SECRET_PERMISSION_DENIED,
    });
  });
});

// ── End-to-end via Config.loadFrom ────────────────────────────────────

describe("Config.loadFrom + VaultSource (mocked)", () => {
  it("loader picks vault scheme and resolves field", async () => {
    const client = buildClient({ api_key: "sk-from-vault" });
    vaultFactory.mockReturnValue(client);
    const src = new InMemorySource({
      llm: { api_key: "${secret:vault:secret/openai#api_key}" },
    });
    const vault = new VaultSource({
      addr: "https://vault.example.com",
      auth: { kind: "token", token: "s.x" },
    });
    const cfg = await Config.loadFrom([src, vault]);
    expect(cfg.getString("llm.api_key")).toBe("sk-from-vault");
  });
});
