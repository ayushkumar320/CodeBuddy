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
    expect(raw).not.toContain("category: general");
    await expect(store.readFact("fact_01abc")).resolves.toMatchObject({
      id: "fact_01abc",
      namespace: "research-agent",
      content: "Use layer caching.",
      createdByAgent: "codex",
      category: "general",
      paths: [],
      severity: null,
    });
  });

  it("round-trips incident metadata on facts", async () => {
    const store = new MemoryFileStore(await temporaryRoot());
    const path = await store.writeFact({
      id: "fact_01incident",
      namespace: "research-agent",
      subject: "src/auth/oauth.ts",
      predicate: "caused",
      object: "login regression",
      confidence: 0.9,
      createdAt: "2026-06-25T10:00:00.000Z",
      createdByAgent: "codex",
      sourceInteractionId: null,
      sourceDeleted: false,
      category: "incident",
      paths: ["src/auth/oauth.ts", "./src/api/login.ts"],
      severity: "high",
      introducedBy: "abc123",
      resolvedBy: null,
      content: "Changing OAuth callback validation broke login.",
    });

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("category: incident");
    expect(raw).toContain("severity: high");
    await expect(store.readFact("fact_01incident")).resolves.toMatchObject({
      category: "incident",
      paths: ["src/auth/oauth.ts", "./src/api/login.ts"],
      severity: "high",
      introducedBy: "abc123",
      resolvedBy: null,
    });
  });

  it("finds unresolved incident facts by repo-relative path", async () => {
    const store = new MemoryFileStore(await temporaryRoot());
    await store.writeFact({
      id: "fact_01low",
      namespace: "research-agent",
      subject: "src/auth/oauth.ts",
      predicate: "caused",
      object: "minor issue",
      confidence: 1,
      createdAt: "2026-06-25T09:00:00.000Z",
      createdByAgent: null,
      sourceInteractionId: null,
      sourceDeleted: false,
      category: "incident",
      paths: ["./src/auth/oauth.ts"],
      severity: "low",
      content: "OAuth had a minor incident.",
    });
    await store.writeFact({
      id: "fact_01high",
      namespace: "research-agent",
      subject: "src/auth/oauth.ts",
      predicate: "caused",
      object: "login outage",
      confidence: 1,
      createdAt: "2026-06-25T10:00:00.000Z",
      createdByAgent: null,
      sourceInteractionId: null,
      sourceDeleted: false,
      category: "incident",
      paths: ["src/auth/oauth.ts"],
      severity: "high",
      content: "OAuth caused a login outage.",
    });
    await store.writeFact({
      id: "fact_01resolved",
      namespace: "research-agent",
      subject: "src/auth/oauth.ts",
      predicate: "caused",
      object: "fixed issue",
      confidence: 1,
      createdAt: "2026-06-25T11:00:00.000Z",
      createdByAgent: null,
      sourceInteractionId: null,
      sourceDeleted: false,
      category: "incident",
      paths: ["src/auth/oauth.ts"],
      severity: "critical",
      resolvedBy: "def456",
      content: "Old OAuth incident was resolved.",
    });

    const active = await store.findIncidentFactsForPaths({
      namespace: "research-agent",
      paths: ["src/auth/oauth.ts"],
    });
    expect(active.map((fact) => fact.id)).toEqual(["fact_01high", "fact_01low"]);

    const withResolved = await store.findIncidentFactsForPaths({
      namespace: "research-agent",
      paths: ["src/auth/oauth.ts"],
      includeResolved: true,
    });
    expect(withResolved.map((fact) => fact.id)).toEqual([
      "fact_01resolved",
      "fact_01high",
      "fact_01low",
    ]);
  });

  it("round-trips a Markdown summary", async () => {
    const store = new MemoryFileStore(await temporaryRoot());
    await store.writeSummary({
      id: "sum_01abc",
      namespace: "research-agent",
      sessionId: "sess_1",
      version: 2,
      tokenCount: 12,
      createdAt: "2026-06-25T10:00:00.000Z",
      createdByAgent: "codex",
      content: "Settled on Markdown-backed memory.",
    });
    await expect(store.readSummary("sum_01abc")).resolves.toMatchObject({
      id: "sum_01abc",
      sessionId: "sess_1",
      version: 2,
      content: "Settled on Markdown-backed memory.",
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

  it("rejects malformed or unterminated front matter", async () => {
    const root = await temporaryRoot();
    const store = new MemoryFileStore(root);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(store.factsDirectory, { recursive: true });
    await writeFile(join(store.factsDirectory, "fact_bad.md"), "---\nid: fact_bad\nno closing");
    await expect(store.readFact("fact_bad")).rejects.toThrow("unterminated YAML front matter");
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
    ).rejects.toThrow("symlinked path");
  });
});
