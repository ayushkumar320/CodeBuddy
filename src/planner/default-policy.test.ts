import { describe, expect, it } from "vitest";
import { InMemoryMemoryRepository } from "../core/in-memory-repository.js";
import { DefaultPolicy } from "./default-policy.js";
import type { PlanInput } from "./types.js";

async function seed(repo: InMemoryMemoryRepository, namespace: string) {
  const ns = await repo.ensureNamespace(namespace);
  return ns.id;
}

function vector(values: number[], length = 384): number[] {
  const out = Array.from({ length }, () => 0);
  for (let i = 0; i < values.length; i++) out[i] = values[i] ?? 0;
  return out;
}

async function insertFact(
  repo: InMemoryMemoryRepository,
  namespaceId: string,
  opts: {
    id: string;
    content: string;
    embedding: number[];
    confidence?: number;
    createdAtOffset?: number;
  },
) {
  await repo.writeFact({
    fact: {
      id: opts.id,
      namespaceId,
      content: opts.content,
      contentHash: `${opts.id}-hash`,
      subject: "__inline__",
      predicate: "asserts",
      object: opts.content.slice(0, 64),
    },
    embedding: {
      id: `${opts.id}-emb`,
      namespaceId,
      ownerType: "fact",
      ownerId: opts.id,
      embeddingModel: "test",
    },
    audit: {
      id: `${opts.id}-aud`,
      namespaceId,
      action: "remember",
      entityType: "fact",
      entityId: opts.id,
    },
  });
  await repo.markEmbeddingReady(`${opts.id}-emb`, opts.embedding, "test");
  if (opts.confidence !== undefined || opts.createdAtOffset !== undefined) {
    const row = repo.facts.get(opts.id);
    if (row && opts.createdAtOffset !== undefined) {
      row.createdAt = Date.now() + opts.createdAtOffset;
    }
  }
}

describe("DefaultPolicy ranking", () => {
  it("ranks higher-cosine items first", async () => {
    const repo = new InMemoryMemoryRepository();
    const namespaceId = await seed(repo, "ns");
    await insertFact(repo, namespaceId, {
      id: "fact_far",
      content: "Irrelevant content about cats.",
      embedding: vector([0, 1, 0]),
    });
    await insertFact(repo, namespaceId, {
      id: "fact_near",
      content: "Highly relevant content about deployments.",
      embedding: vector([1, 0, 0]),
    });

    const policy = new DefaultPolicy({ minVectorScore: -1 });
    const input: PlanInput = {
      namespace: "ns",
      namespaceId,
      sessionId: "session-x",
      query: "deployments",
      budget: 1_000,
      conflictMode: "all",
      queryEmbedding: vector([1, 0, 0]),
      repository: repo,
    };
    const planned = await policy.plan(input);
    const first = planned.messages[0];
    expect(first?.content).toContain("deployments");
  });

  it("falls back to recency when no embeddings are ready", async () => {
    const repo = new InMemoryMemoryRepository();
    const namespaceId = await seed(repo, "ns");
    await repo.writeInteraction({
      interaction: {
        id: "int_1",
        namespaceId,
        sessionId: "sess",
        content: "the only interaction",
        contentHash: "h1",
        tokenCount: 4,
      },
      embedding: {
        id: "emb_1",
        namespaceId,
        ownerType: "interaction",
        ownerId: "int_1",
        embeddingModel: "test",
      },
      audit: {
        id: "aud_1",
        namespaceId,
        action: "remember",
        entityType: "interaction",
        entityId: "int_1",
      },
    });

    const policy = new DefaultPolicy();
    const planned = await policy.plan({
      namespace: "ns",
      namespaceId,
      sessionId: "sess",
      query: "anything",
      budget: 1_000,
      conflictMode: "all",
      queryEmbedding: null,
      repository: repo,
    });
    expect(planned.stats.fallback).not.toBe("none");
    expect(planned.messages.length).toBeGreaterThan(0);
  });

  it("conflict mode 'latest' picks the newest of duplicates", async () => {
    const repo = new InMemoryMemoryRepository();
    const namespaceId = await seed(repo, "ns");
    await insertFact(repo, namespaceId, {
      id: "f_old",
      content: "duplicate content",
      embedding: vector([1, 0]),
      createdAtOffset: -1_000_000,
    });
    await insertFact(repo, namespaceId, {
      id: "f_new",
      content: "duplicate content",
      embedding: vector([1, 0]),
      createdAtOffset: 0,
    });
    // hash differs in seed, so both rows exist
    const policy = new DefaultPolicy({ minVectorScore: -1 });
    const planned = await policy.plan({
      namespace: "ns",
      namespaceId,
      sessionId: "sess",
      query: "anything",
      budget: 1_000,
      conflictMode: "latest",
      queryEmbedding: vector([1, 0]),
      repository: repo,
    });
    const factMessages = planned.messages.filter((m) => m.content === "duplicate content");
    expect(factMessages).toHaveLength(1);
  });

  it("respects budget by skipping with budget_exhausted reason", async () => {
    const repo = new InMemoryMemoryRepository();
    const namespaceId = await seed(repo, "ns");
    for (let i = 0; i < 4; i++) {
      await insertFact(repo, namespaceId, {
        id: `f${i}`,
        content: `padded content item ${i} ${"x".repeat(60)}`,
        embedding: vector([1, 0]),
      });
    }
    const policy = new DefaultPolicy({ minVectorScore: -1 });
    const planned = await policy.plan({
      namespace: "ns",
      namespaceId,
      sessionId: "sess",
      query: "x",
      budget: 10,
      conflictMode: "all",
      queryEmbedding: vector([1, 0]),
      repository: repo,
    });
    expect(planned.stats.itemsSkipped).toBeGreaterThan(0);
    expect(planned.stats.skipReasons.budget_exhausted ?? 0).toBeGreaterThan(0);
    expect(planned.stats.tokensUsed).toBeLessThanOrEqual(10);
  });
});
