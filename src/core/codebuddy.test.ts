import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingRequest, ModelProvider } from "../providers/adapter.js";
import { CodeBuddy } from "./codebuddy.js";
import { InMemoryMemoryRepository } from "./in-memory-repository.js";
import { MemoryFileStore } from "./memory-file-store.js";
import type { CodeBuddyConfig } from "./types.js";

function mockProvider(
  overrides: Partial<{ embed: ModelProvider["embed"]; vector: number[] }> = {},
): ModelProvider {
  const vector =
    overrides.vector ?? Array.from({ length: 384 }, (_, index) => Math.sin(index) * 0.01);
  return {
    embed:
      overrides.embed ??
      (async (_: EmbeddingRequest) => ({
        model: "sentence-transformers/all-MiniLM-L6-v2",
        dimensions: 384,
        vectors: [vector],
      })),
    generateText: async () => ({
      model: "stub",
      text: "stub",
    }),
  };
}

const baseConfig: CodeBuddyConfig = {
  postgresUrl: "postgres://stub",
  provider: { type: "huggingface", apiKey: "stub" },
  namespace: "research-agent",
  worker: { pollIntervalMs: 50, batchSize: 4, maxAttempts: 3 },
};

async function buildSdk(opts: { provider?: ModelProvider } = {}) {
  const repository = new InMemoryMemoryRepository();
  const provider = opts.provider ?? mockProvider();
  const sdk = new CodeBuddy(baseConfig, { repository, provider });
  await sdk.init();
  return { sdk, repository, provider };
}

describe("config validation", () => {
  it("rejects invalid namespace characters", () => {
    expect(
      () =>
        new CodeBuddy(
          { ...baseConfig, namespace: "bad space" },
          { repository: new InMemoryMemoryRepository() },
        ),
    ).toThrow();
  });

  it("rejects missing postgresUrl", () => {
    expect(
      () =>
        new CodeBuddy(
          { ...baseConfig, postgresUrl: "" },
          { repository: new InMemoryMemoryRepository() },
        ),
    ).toThrow();
  });

  it("rejects an unrecognized provider", () => {
    expect(
      () =>
        new CodeBuddy(
          // @ts-expect-error testing runtime validation
          { ...baseConfig, provider: { type: "openai" } },
          { repository: new InMemoryMemoryRepository() },
        ),
    ).toThrow();
  });
});

describe("remember", () => {
  it("generates a session id when omitted", async () => {
    const { sdk } = await buildSdk();
    const result = await sdk.remember({ content: "hello world" });
    expect(result.sessionId).toMatch(/^sess_/);
    expect(result.deduplicated).toBe(false);
    await sdk.shutdown();
  });

  it("is idempotent on identical content", async () => {
    const { sdk } = await buildSdk();
    const first = await sdk.remember({ sessionId: "sess_a", content: "duplicate-me" });
    const second = await sdk.remember({ sessionId: "sess_a", content: "duplicate-me" });
    expect(second.id).toBe(first.id);
    expect(second.deduplicated).toBe(true);
    await sdk.shutdown();
  });

  it("is idempotent via explicit key", async () => {
    const { sdk } = await buildSdk();
    const first = await sdk.remember({
      sessionId: "sess_a",
      content: "v1",
      idempotencyKey: "key-1",
    });
    const second = await sdk.remember({
      sessionId: "sess_a",
      content: "v2-different-text",
      idempotencyKey: "key-1",
    });
    expect(second.id).toBe(first.id);
    expect(second.deduplicated).toBe(true);
    await sdk.shutdown();
  });

  it("supports fact writes with their own dedupe", async () => {
    const { sdk, repository } = await buildSdk();
    await sdk.remember({ content: "Use layer caching.", type: "fact" });
    const dup = await sdk.remember({ content: "Use layer caching.", type: "fact" });
    expect(dup.deduplicated).toBe(true);
    expect(repository.facts.size).toBe(1);
    await sdk.shutdown();
  });

  it("dual-writes facts to Markdown without duplicating files", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-dual-write-"));
    try {
      const repository = new InMemoryMemoryRepository();
      const store = new MemoryFileStore(root);
      const sdk = new CodeBuddy(baseConfig, {
        repository,
        provider: mockProvider(),
        memoryFileStore: store,
      });
      await sdk.init();
      const first = await sdk.remember({ content: "Use layer caching.", type: "fact" });
      const second = await sdk.remember({ content: "Use layer caching.", type: "fact" });
      expect(second.id).toBe(first.id);
      expect(await store.listFacts()).toHaveLength(1);
      expect((await store.readFact(first.id)).content).toBe("Use layer caching.");
      await sdk.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds fact records from Markdown after repository recreation", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-reindex-"));
    try {
      const store = new MemoryFileStore(root);
      const firstRepository = new InMemoryMemoryRepository();
      const firstSdk = new CodeBuddy(baseConfig, {
        repository: firstRepository,
        provider: mockProvider(),
        memoryFileStore: store,
      });
      await firstSdk.init();
      const remembered = await firstSdk.remember({
        content: "Deployment target is eu-west-1.",
        type: "fact",
      });
      await firstSdk.shutdown();

      const rebuiltRepository = new InMemoryMemoryRepository();
      const rebuiltSdk = new CodeBuddy(baseConfig, {
        repository: rebuiltRepository,
        provider: mockProvider(),
        memoryFileStore: store,
      });
      await rebuiltSdk.init();
      const result = await rebuiltSdk.reindexFacts();
      expect(result).toEqual({ scanned: 1, imported: 1, deduplicated: 0 });
      expect(rebuiltRepository.facts.get(remembered.id)?.content).toBe(
        "Deployment target is eu-west-1.",
      );
      await rebuiltSdk.getWorker().drain();
      const recalled = await rebuiltSdk.recall({
        sessionId: "recovered",
        query: "deployment target",
      });
      expect(recalled.messages.some((message) => message.content.includes("eu-west-1"))).toBe(true);
      await rebuiltSdk.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("dual-writes and rebuilds summaries from Markdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-summary-reindex-"));
    try {
      const store = new MemoryFileStore(root);
      const firstRepository = new InMemoryMemoryRepository();
      const firstSdk = new CodeBuddy(baseConfig, {
        repository: firstRepository,
        provider: mockProvider(),
        memoryFileStore: store,
      });
      await firstSdk.init();
      const remembered = await firstSdk.remember({
        sessionId: "sess_summary",
        content: "OAuth design was completed.",
        type: "summary",
      });
      expect((await store.readSummary(remembered.id)).sessionId).toBe("sess_summary");
      await firstSdk.shutdown();

      const rebuiltRepository = new InMemoryMemoryRepository();
      const rebuiltSdk = new CodeBuddy(baseConfig, {
        repository: rebuiltRepository,
        provider: mockProvider(),
        memoryFileStore: store,
      });
      await rebuiltSdk.init();
      const result = await rebuiltSdk.reindexMemory();
      expect(result.summaries).toEqual({ scanned: 1, imported: 1, deduplicated: 0 });
      const rebuiltNamespace = await rebuiltRepository.getNamespaceByName("research-agent");
      if (!rebuiltNamespace) throw new Error("Expected rebuilt namespace.");
      expect(
        await rebuiltRepository.getLatestSummary(rebuiltNamespace.id, "sess_summary"),
      ).toMatchObject({ id: remembered.id, content: "OAuth design was completed." });
      await rebuiltSdk.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates the embedding row as pending inside the write", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sdk, repository } = await buildSdk({
      provider: mockProvider({
        embed: async () => {
          await gate;
          return {
            model: "sentence-transformers/all-MiniLM-L6-v2",
            dimensions: 384,
            vectors: [Array.from({ length: 384 }, () => 0)],
          };
        },
      }),
    });
    await sdk.remember({ content: "needs embedding" });
    // The worker claims immediately (row moves to 'processing' under its
    // lease); before any claim it must still be 'pending'.
    const embeddings = Array.from(repository.embeddings.values());
    expect(embeddings).toHaveLength(1);
    expect(["pending", "processing"]).toContain(embeddings[0]?.status);
    release();
    await sdk.shutdown();
  });
});

describe("rememberBatch", () => {
  it("dedupes within the batch", async () => {
    const { sdk } = await buildSdk();
    const results = await sdk.rememberBatch([
      { sessionId: "s1", content: "alpha" },
      { sessionId: "s1", content: "alpha" },
      { sessionId: "s1", content: "beta" },
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]?.deduplicated).toBe(false);
    expect(results[1]?.deduplicated).toBe(true);
    expect(results[1]?.id).toBe(results[0]?.id);
    expect(results[2]?.deduplicated).toBe(false);
    await sdk.shutdown();
  });
});

describe("embedding worker", () => {
  it("transitions pending -> ready when provider succeeds", async () => {
    const { sdk, repository } = await buildSdk();
    const { id } = await sdk.remember({ content: "needs vector" });
    await sdk.getWorker().drain();
    const emb = Array.from(repository.embeddings.values()).find((row) => row.ownerId === id);
    expect(emb?.status).toBe("ready");
    expect(emb?.vector).toHaveLength(384);
    await sdk.shutdown();
  });

  it("marks failed after maxAttempts when provider keeps throwing", async () => {
    const failing = mockProvider({
      embed: vi.fn(async () => {
        throw new Error("HF cold start exceeded retries");
      }),
    });
    const repository = new InMemoryMemoryRepository();
    const sdk = new CodeBuddy(baseConfig, { repository, provider: failing });
    await sdk.init();
    const { id } = await sdk.remember({ content: "will fail" });
    for (let i = 0; i < 8; i++) {
      await sdk.getWorker().drain();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const emb = Array.from(repository.embeddings.values()).find((row) => row.ownerId === id);
    expect(emb).toBeTruthy();
    // Either parked as terminal 'failed', or mid-backoff in 'processing'
    // waiting out its retry timer.
    expect(["failed", "processing"]).toContain(emb?.status);
    expect((emb?.attempts ?? 0) > 0).toBe(true);
    await sdk.shutdown();
  });

  it("drain returns once outstanding work clears", async () => {
    const { sdk } = await buildSdk();
    await sdk.rememberBatch(
      Array.from({ length: 5 }, (_, index) => ({
        sessionId: "s",
        content: `payload-${index}`,
      })),
    );
    await sdk.getWorker().drain();
    expect(sdk.getWorker().getState()).toBe("running");
    await sdk.shutdown();
    expect(sdk.getWorker().getState()).toBe("stopped");
  });

  it("shutdown awaits in-flight work", async () => {
    const { sdk } = await buildSdk();
    await sdk.remember({ content: "graceful shutdown" });
    await sdk.shutdown();
    expect(sdk.getWorker().getState()).toBe("stopped");
  });
});

describe("share", () => {
  it("rejects same-namespace shares", async () => {
    const { sdk } = await buildSdk();
    await expect(
      sdk.share({ from: "research-agent", to: "research-agent", factIds: ["x"] }),
    ).rejects.toThrow();
    await sdk.shutdown();
  });

  it("creates a reference share without copying the fact", async () => {
    const { sdk, repository } = await buildSdk();
    const factsBefore = repository.facts.size;
    const result = await sdk.share({
      from: "research-agent",
      to: "ops-agent",
      factIds: ["fact_abc"],
      mode: "reference",
    });
    expect(result.shared).toBe(1);
    expect(repository.facts.size).toBe(factsBefore);
    const share = Array.from(repository.shares.values())[0];
    expect(share?.mode).toBe("reference");
    expect(share?.snapshotFactId).toBeUndefined();
    await sdk.shutdown();
  });

  it("snapshot mode copies a real fact's content into the target namespace", async () => {
    const { sdk, repository } = await buildSdk();
    await sdk.remember({ type: "fact", content: "Deploy requires the staging DB up." });
    const sourceNs = await repository.getNamespaceByName("research-agent");
    expect(sourceNs).toBeTruthy();
    const sourceFact = Array.from(repository.facts.values()).find(
      (row) => row.namespaceId === sourceNs?.id,
    );
    if (!sourceFact) throw new Error("expected a seeded source fact");
    const before = repository.facts.size;
    const result = await sdk.share({
      from: "research-agent",
      to: "ops-agent",
      factIds: [sourceFact.id],
      mode: "snapshot",
    });
    expect(result.shared).toBe(1);
    expect(repository.facts.size).toBe(before + 1);
    const share = Array.from(repository.shares.values())[0];
    expect(share?.mode).toBe("snapshot");
    expect(share?.snapshotFactId).toBeTruthy();
    // The snapshot must carry the source knowledge, not a dangling pointer.
    const snapshotFact = repository.facts.get(share?.snapshotFactId ?? "");
    expect(snapshotFact?.content).toContain("Deploy requires the staging DB up.");
    expect(snapshotFact?.content).not.toContain("__snapshot:");
    await sdk.shutdown();
  });

  it("snapshot mode rejects fact ids that do not exist in the source namespace", async () => {
    const { sdk } = await buildSdk();
    await expect(
      sdk.share({
        from: "research-agent",
        to: "ops-agent",
        factIds: ["fact_abc"],
        mode: "snapshot",
      }),
    ).rejects.toThrow(/not found/);
    await sdk.shutdown();
  });
});

describe("forget", () => {
  it("hard-deletes an interaction and its embedding", async () => {
    const { sdk, repository } = await buildSdk();
    const { id } = await sdk.remember({ content: "kill-me", sessionId: "s" });
    const result = await sdk.forget(id);
    expect(result.ok).toBe(true);
    expect(result.entityType).toBe("interaction");
    expect(repository.interactions.has(id)).toBe(false);
    const orphan = Array.from(repository.embeddings.values()).find((row) => row.ownerId === id);
    expect(orphan).toBeUndefined();
    await sdk.shutdown();
  });

  it("forget(factId) tombstones a referenced share", async () => {
    const { sdk, repository } = await buildSdk();
    const { id: factId } = await sdk.remember({ content: "shared-fact", type: "fact" });
    await sdk.share({
      from: "research-agent",
      to: "ops-agent",
      factIds: [factId],
      mode: "reference",
    });
    await sdk.forget(factId);
    const share = Array.from(repository.shares.values())[0];
    expect(share?.tombstoned).toBe(true);
    await sdk.shutdown();
  });

  it("returns unknown for missing ids", async () => {
    const { sdk } = await buildSdk();
    const result = await sdk.forget("does-not-exist");
    expect(result.ok).toBe(false);
    expect(result.entityType).toBe("unknown");
    await sdk.shutdown();
  });
});

describe("recall", () => {
  it("rejects empty queries", async () => {
    const { sdk } = await buildSdk();
    await expect(sdk.recall({ sessionId: "s", query: "" })).rejects.toThrow();
    await sdk.shutdown();
  });

  it("returns planned context once embeddings are ready", async () => {
    const { sdk } = await buildSdk();
    await sdk.remember({ sessionId: "s1", content: "Deployment target is eu-west-1." });
    await sdk.remember({ sessionId: "s1", content: "Use layer caching." });
    await sdk.getWorker().drain();
    const planned = await sdk.recall({ sessionId: "s1", query: "deployment region" });
    expect(planned.system).toMatch(/research-agent/);
    expect(planned.messages.length).toBeGreaterThan(0);
    expect(planned.stats.tokensUsed).toBeGreaterThan(0);
    expect(planned.stats.itemsIncluded).toBeGreaterThan(0);
    expect(planned.stats.embeddingCoverage.ready).toBeGreaterThan(0);
    expect(planned.stats.fallback).toBe("none");
    await sdk.shutdown();
  });

  it("falls back to recency when embeddings are still pending", async () => {
    const repository = new InMemoryMemoryRepository();
    // worker poll interval is far in the future so embeddings stay pending
    const slowWorkerConfig: CodeBuddyConfig = {
      ...baseConfig,
      worker: { pollIntervalMs: 60_000, batchSize: 4, maxAttempts: 3 },
    };
    const sdk = new CodeBuddy(slowWorkerConfig, {
      repository,
      provider: mockProvider(),
    });
    await sdk.init();
    await sdk.getWorker().stop();
    await sdk.remember({ sessionId: "s2", content: "Pending interaction one." });
    await sdk.remember({ sessionId: "s2", content: "Pending interaction two." });
    const planned = await sdk.recall({ sessionId: "s2", query: "what's pending?" });
    expect(planned.stats.fallback).not.toBe("none");
    expect(planned.stats.embeddingCoverage.ready).toBe(0);
    expect(planned.stats.embeddingCoverage.pending).toBeGreaterThan(0);
    expect(planned.messages.length).toBeGreaterThan(0);
    await sdk.shutdown();
  });

  it("clamps budget when caller model context window is too small", async () => {
    const { sdk } = await buildSdk();
    await sdk.remember({ sessionId: "s3", content: "anything" });
    await sdk.getWorker().drain();
    const planned = await sdk.recall({
      sessionId: "s3",
      query: "anything",
      budget: 999_999,
      callerModel: "Qwen/Qwen2.5-7B-Instruct",
    });
    expect(planned.stats.budgetClamped).toBe(true);
    expect(planned.stats.budgetClampReason).toContain("clamped");
    await sdk.shutdown();
  });

  it("respects a small budget by skipping items", async () => {
    const { sdk } = await buildSdk();
    for (let i = 0; i < 5; i++) {
      await sdk.remember({
        sessionId: "s4",
        content: `Long-ish content item number ${i} talking about kubernetes deployments and caching.`,
      });
    }
    await sdk.getWorker().drain();
    const planned = await sdk.recall({
      sessionId: "s4",
      query: "kubernetes",
      budget: 20,
    });
    expect(planned.stats.tokensUsed).toBeLessThanOrEqual(20);
    expect(planned.stats.itemsSkipped).toBeGreaterThan(0);
    expect(planned.stats.skipReasons.budget_exhausted ?? 0).toBeGreaterThan(0);
    await sdk.shutdown();
  });
});
