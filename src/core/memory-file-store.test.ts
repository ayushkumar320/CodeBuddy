import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFileStore } from "./memory-file-store.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-memory-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MemoryFileStore", () => {
  it("round-trips a Markdown fact with stable front matter", async () => {
    const root = await temporaryRoot();
    const store = new MemoryFileStore(root);
    const path = await store.writeFact({
      id: "fact_01abc",
      namespace: "research-agent",
      subject: "__inline__",
      predicate: "asserts",
      object: "Use layer caching.",
      confidence: 1,
      createdAt: "2026-06-25T10:00:00.000Z",
      createdByAgent: "codex",
      sourceInteractionId: null,
      sourceDeleted: false,
      content: "Use layer caching.",
    });

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("schemaVersion: 1");
    expect(raw).toContain("type: fact");
    await expect(store.readFact("fact_01abc")).resolves.toMatchObject({
      id: "fact_01abc",
      namespace: "research-agent",
      content: "Use layer caching.",
      createdByAgent: "codex",
    });
  });

  it("rejects invalid fact ids", async () => {
    const store = new MemoryFileStore(await temporaryRoot());
    await expect(
      store.writeFact({
        id: "../../escape",
        namespace: "research-agent",
        subject: "x",
        predicate: "is",
        object: "y",
        confidence: 1,
        createdAt: new Date().toISOString(),
        createdByAgent: null,
        sourceInteractionId: null,
        sourceDeleted: false,
        content: "unsafe",
      }),
    ).rejects.toThrow("Invalid fact id");
  });

  it("refuses a symlinked .codebuddy directory", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, join(root, ".codebuddy"));
    const store = new MemoryFileStore(root);
    await expect(
      store.writeFact({
        id: "fact_01abc",
        namespace: "research-agent",
        subject: "x",
        predicate: "is",
        object: "y",
        confidence: 1,
        createdAt: new Date().toISOString(),
        createdByAgent: null,
        sourceInteractionId: null,
        sourceDeleted: false,
        content: "unsafe",
      }),
    ).rejects.toThrow("symlinked memory path");
  });
});
