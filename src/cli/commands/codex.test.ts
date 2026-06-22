import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installCodexEntry,
  listCodexEntries,
  readCodexConfig,
  removeCodexEntry,
  writeCodexConfig,
} from "./codex.js";

let dir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codebuddy-codex-"));
  originalHome = process.env.HOME;
  process.env.HOME = dir;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("codex install / list / remove", () => {
  it("creates a fresh config file with the new server entry", async () => {
    const result = await installCodexEntry({
      namespace: "alpha",
      hfToken: "hf_a",
      databaseUrl: "postgres://a",
    });

    expect(result.created).toBe(true);
    expect(result.serverKey).toBe("codebuddy-alpha");
    const config = await readCodexConfig(result.path);
    expect(config).toContain('[mcp_servers."codebuddy-alpha"]');
    expect(config).toContain('CODEBUDDY_NAMESPACE = "alpha"');
  });

  it("merges into an existing config without clobbering other settings", async () => {
    const path = join(dir, ".codex", "config.toml");
    await writeCodexConfig(
      path,
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.node_repl]",
        'command = "node_repl"',
        "args = []",
        "",
      ].join("\n"),
    );

    await installCodexEntry({ namespace: "beta", hfToken: "hf_b" });
    const config = await readCodexConfig(path);
    expect(config).toContain('model = "gpt-5"');
    expect(config).toContain("[mcp_servers.node_repl]");
    expect(config).toContain('[mcp_servers."codebuddy-beta"]');
  });

  it("updates an existing codebuddy entry instead of duplicating it", async () => {
    await installCodexEntry({
      namespace: "gamma",
      hfToken: "hf_old",
      databaseUrl: "postgres://old",
    });
    const result = await installCodexEntry({
      namespace: "gamma",
      hfToken: "hf_new",
      databaseUrl: "postgres://new",
    });
    const config = await readCodexConfig(result.path);

    expect(result.created).toBe(false);
    expect(config.match(/\[mcp_servers\."codebuddy-gamma"\]/g)).toHaveLength(1);
    expect(config).toContain('HF_TOKEN = "hf_new"');
    expect(config).toContain('DATABASE_URL = "postgres://new"');
    expect(config).not.toContain("hf_old");
  });

  it("list returns codebuddy entries with namespace and db", async () => {
    await installCodexEntry({
      namespace: "delta",
      hfToken: "hf_d",
      databaseUrl: "postgres://d",
    });
    const result = await listCodexEntries();
    const found = result.entries.find((entry) => entry.key === "codebuddy-delta");

    expect(found?.namespace).toBe("delta");
    expect(found?.databaseUrl).toBe("postgres://d");
  });

  it("remove deletes only the requested key", async () => {
    await installCodexEntry({ namespace: "epsilon" });
    await installCodexEntry({ namespace: "zeta" });
    const removed = await removeCodexEntry("codebuddy-epsilon");
    const list = await listCodexEntries();

    expect(removed.removed).toBe(true);
    expect(list.entries.map((entry) => entry.key)).toEqual(["codebuddy-zeta"]);
  });

  it("remove returns false when the entry does not exist", async () => {
    await writeFile(join(dir, "keep.txt"), "noop", "utf8");
    const result = await removeCodexEntry("codebuddy-nope");
    expect(result.removed).toBe(false);
  });
});
