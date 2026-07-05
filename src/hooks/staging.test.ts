import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookStagingStore } from "./staging.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-staging-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("HookStagingStore", () => {
  it("normalizes paths and drops empties on add", async () => {
    const store = new HookStagingStore(await tempRoot());
    await store.add("s", ["./src/a.ts", "src\\b.ts", "  ", ""]);
    expect(await store.read("s")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("is a no-op when adding an all-empty set (no file created)", async () => {
    const store = new HookStagingStore(await tempRoot());
    await store.add("s", ["", "  "]);
    expect(await store.read("s")).toEqual([]);
  });

  it("returns an empty list for an unknown session", async () => {
    const store = new HookStagingStore(await tempRoot());
    expect(await store.read("never-staged")).toEqual([]);
    expect(await store.drain("never-staged")).toEqual([]);
  });

  it("sanitizes session ids so they can't escape the staging dir", async () => {
    const store = new HookStagingStore(await tempRoot());
    await store.add("../../etc/passwd", ["src/a.ts"]);
    // Same sanitized key round-trips; nothing is written outside the dir.
    expect(await store.read("../../etc/passwd")).toEqual(["src/a.ts"]);
    expect(await store.read("______etc_passwd")).toEqual(["src/a.ts"]);
  });

  it("drain clears the staged set", async () => {
    const store = new HookStagingStore(await tempRoot());
    await store.add("s", ["src/a.ts"]);
    expect(await store.drain("s")).toEqual(["src/a.ts"]);
    expect(await store.read("s")).toEqual([]);
  });
});
