import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildEntry,
  installClaudeEntry,
  listClaudeEntries,
  readClaudeConfig,
  removeClaudeEntry,
  writeClaudeConfig,
} from "./claude-desktop.js";

let dir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codebuddy-claude-"));
  originalHome = process.env.HOME;
  // claudeDesktopConfigPath builds from process.env.HOME on darwin/linux
  process.env.HOME = dir;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("buildEntry", () => {
  it("inlines env vars and points at the resolved CLI entrypoint", () => {
    const entry = buildEntry({
      namespace: "demo",
      hfToken: "hf_xxx",
      groqApiKey: "gsk_xxx",
      databaseUrl: "postgres://x@y/z",
    });
    expect(entry.command).toBe("node");
    expect(entry.args).toHaveLength(2);
    expect(entry.args[1]).toBe("serve");
    expect(entry.env).toMatchObject({
      CODEBUDDY_NAMESPACE: "demo",
      HF_TOKEN: "hf_xxx",
      GROQ_API_KEY: "gsk_xxx",
      DATABASE_URL: "postgres://x@y/z",
    });
  });

  it("omits optional env values when not provided", () => {
    const entry = buildEntry({ namespace: "demo" });
    expect(entry.env).toEqual({ CODEBUDDY_NAMESPACE: "demo" });
  });
});

describe("install / list / remove", () => {
  it("creates a fresh config file with the new server entry", async () => {
    const result = await installClaudeEntry({
      namespace: "alpha",
      hfToken: "hf_a",
      databaseUrl: "postgres://a",
    });
    expect(result.created).toBe(true);
    expect(result.serverKey).toBe("codebuddy-alpha");
    const config = await readClaudeConfig(result.path);
    expect(config.mcpServers?.["codebuddy-alpha"]).toBeTruthy();
    expect(config.mcpServers?.["codebuddy-alpha"]?.env?.CODEBUDDY_NAMESPACE).toBe("alpha");
  });

  it("merges into an existing config without clobbering other servers", async () => {
    const path = join(
      dir,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
    await writeClaudeConfig(path, {
      mcpServers: {
        "some-other": { command: "node", args: ["/x/y.js"] },
      },
    });
    await installClaudeEntry({ namespace: "beta", hfToken: "hf_b" });
    const config = await readClaudeConfig(path);
    expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual(["codebuddy-beta", "some-other"]);
  });

  it("list returns codebuddy entries with namespace and db", async () => {
    await installClaudeEntry({
      namespace: "gamma",
      hfToken: "hf_g",
      databaseUrl: "postgres://g",
    });
    const result = await listClaudeEntries();
    const found = result.entries.find((e) => e.key === "codebuddy-gamma");
    expect(found?.namespace).toBe("gamma");
    expect(found?.databaseUrl).toBe("postgres://g");
  });

  it("remove deletes only the requested key", async () => {
    await installClaudeEntry({ namespace: "delta" });
    await installClaudeEntry({ namespace: "epsilon" });
    const removed = await removeClaudeEntry("codebuddy-delta");
    expect(removed.removed).toBe(true);
    const list = await listClaudeEntries();
    expect(list.entries.map((e) => e.key)).toEqual(["codebuddy-epsilon"]);
  });

  it("remove returns false when the entry does not exist", async () => {
    const result = await removeClaudeEntry("codebuddy-nope");
    expect(result.removed).toBe(false);
  });

  it("install with a custom serverName uses it as the key", async () => {
    const result = await installClaudeEntry({
      namespace: "zeta",
      serverName: "memory-zeta",
    });
    expect(result.serverKey).toBe("memory-zeta");
    const list = await listClaudeEntries();
    // memory-zeta won't show because list filters on codebuddy / codebuddy- prefix
    expect(list.entries.find((e) => e.key === "memory-zeta")).toBeUndefined();
  });

  it("refuses to parse a malformed config", async () => {
    const path = join(
      dir,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "Library", "Application Support", "Claude"), { recursive: true });
    await writeFile(path, "{ not valid json", "utf8");
    await expect(readClaudeConfig(path)).rejects.toThrow();
  });
});
