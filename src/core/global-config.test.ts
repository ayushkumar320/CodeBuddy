import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  globalConfigPath,
  mergeGlobalConfig,
  readGlobalConfig,
  writeGlobalConfig,
} from "./global-config.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "codebuddy-global-"));
});

afterEach(() => {
  // tmpdir entries are cleaned up by the OS; nothing else to do.
});

describe("globalConfigPath", () => {
  it("resolves to ~/.codebuddy/global.json", () => {
    expect(globalConfigPath(home)).toBe(join(home, ".codebuddy", "global.json"));
  });
});

describe("readGlobalConfig", () => {
  it("returns an empty object when the file does not exist", async () => {
    expect(await readGlobalConfig(home)).toEqual({});
  });
});

describe("writeGlobalConfig", () => {
  it("creates the file with 0600 permissions and parses back", async () => {
    const { path } = await writeGlobalConfig(
      { hfToken: "hf_xxx", databaseUrl: "postgres://x" },
      home,
    );
    const info = await stat(path);
    const mode = info.mode & 0o777;
    expect(mode).toBe(0o600);
    const round = await readGlobalConfig(home);
    expect(round).toEqual({ hfToken: "hf_xxx", databaseUrl: "postgres://x" });
  });
});

describe("mergeGlobalConfig", () => {
  it("preserves existing values when patch omits them", async () => {
    await writeGlobalConfig({ hfToken: "hf_x", databaseUrl: "postgres://a" }, home);
    await mergeGlobalConfig({ databaseUrl: "postgres://b" }, home);
    const result = await readGlobalConfig(home);
    expect(result).toEqual({ hfToken: "hf_x", databaseUrl: "postgres://b" });
  });

  it("creates the file on first merge", async () => {
    await mergeGlobalConfig({ hfToken: "hf_new" }, home);
    const result = await readGlobalConfig(home);
    expect(result.hfToken).toBe("hf_new");
  });
});
