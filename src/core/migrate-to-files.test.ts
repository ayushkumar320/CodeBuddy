import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateEntityId } from "./ids.js";
import { InMemoryMemoryRepository } from "./in-memory-repository.js";
import { MemoryFileStore } from "./memory-file-store.js";
import { migrateMemoryToFiles } from "./migrate-to-files.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-migrate-"));
  roots.push(root);
  const repository = new InMemoryMemoryRepository();
  const namespace = await repository.ensureNamespace("research-agent");
  await repository.writeFact({
    fact: {
      id: "fact_01abc",
      namespaceId: namespace.id,
      content: "Use eu-west-1.",
      contentHash: "fact-hash",
      subject: "deployment.region",
      predicate: "is",
      object: "eu-west-1",
    },
    embedding: {
      id: generateEntityId("emb"),
      namespaceId: namespace.id,
      ownerType: "fact",
      ownerId: "fact_01abc",
      embeddingModel: "test",
    },
    audit: {
      id: generateEntityId("aud"),
      namespaceId: namespace.id,
      action: "remember",
      entityType: "fact",
      entityId: "fact_01abc",
    },
  });
  await repository.writeSummary({
    summary: {
      id: "sum_01abc",
      namespaceId: namespace.id,
      sessionId: "sess_1",
      content: "Deployment decision complete.",
      version: 1,
      tokenCount: 4,
    },
    embedding: {
      id: generateEntityId("emb"),
      namespaceId: namespace.id,
      ownerType: "summary",
      ownerId: "sum_01abc",
      embeddingModel: "test",
    },
    audit: {
      id: generateEntityId("aud"),
      namespaceId: namespace.id,
      action: "remember",
      entityType: "summary",
      entityId: "sum_01abc",
    },
  });
  return { repository, store: new MemoryFileStore(root) };
}

describe("migrateMemoryToFiles", () => {
  it("dry-run reports files without writing them", async () => {
    const { repository, store } = await fixture();
    const result = await migrateMemoryToFiles({
      repository,
      store,
      namespace: "research-agent",
      write: false,
    });
    expect(result.facts.toWrite).toBe(1);
    expect(result.summaries.toWrite).toBe(1);
    expect(await store.listFacts()).toHaveLength(0);
    expect(await store.listSummaries()).toHaveLength(0);
  });

  it("writes only missing files and becomes idempotent", async () => {
    const { repository, store } = await fixture();
    await migrateMemoryToFiles({
      repository,
      store,
      namespace: "research-agent",
      write: true,
    });
    const second = await migrateMemoryToFiles({
      repository,
      store,
      namespace: "research-agent",
      write: true,
    });
    expect(second.facts).toMatchObject({ found: 1, existing: 1, toWrite: 0, conflicts: 0 });
    expect(second.summaries).toMatchObject({ found: 1, existing: 1, toWrite: 0, conflicts: 0 });
  });

  it("reports same-id content conflicts without overwriting the file", async () => {
    const { repository, store } = await fixture();
    await store.writeFact({
      id: "fact_01abc",
      namespace: "research-agent",
      subject: "deployment.region",
      predicate: "is",
      object: "us-east-1",
      confidence: 1,
      createdAt: new Date().toISOString(),
      createdByAgent: null,
      sourceInteractionId: null,
      sourceDeleted: false,
      content: "Use us-east-1.",
    });
    const result = await migrateMemoryToFiles({
      repository,
      store,
      namespace: "research-agent",
      write: true,
    });
    expect(result.facts).toMatchObject({ found: 1, existing: 0, toWrite: 0, conflicts: 1 });
    expect(result.conflicts[0]).toMatchObject({ kind: "fact", id: "fact_01abc" });
    expect((await store.readFact("fact_01abc")).content).toBe("Use us-east-1.");
  });
});
