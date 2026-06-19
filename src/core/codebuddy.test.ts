import { describe, expect, it, vi } from "vitest";
import type { EmbeddingRequest, ModelProvider } from "../providers/adapter.js";
import { CodeBuddy } from "./codebuddy.js";
import { InMemoryMemoryRepository } from "./in-memory-repository.js";
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
    const embeddings = Array.from(repository.embeddings.values());
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]?.status).toBe("pending");
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
    expect(["failed", "pending"]).toContain(emb?.status);
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

  it("snapshot mode copies a fact into the target namespace", async () => {
    const { sdk, repository } = await buildSdk();
    const before = repository.facts.size;
    await sdk.share({
      from: "research-agent",
      to: "ops-agent",
      factIds: ["fact_abc"],
      mode: "snapshot",
    });
    expect(repository.facts.size).toBe(before + 1);
    const share = Array.from(repository.shares.values())[0];
    expect(share?.mode).toBe("snapshot");
    expect(share?.snapshotFactId).toBeTruthy();
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

describe("recall placeholder", () => {
  it("throws until Phase 5 is implemented", async () => {
    const { sdk } = await buildSdk();
    await expect(sdk.recall({ sessionId: "s", query: "anything" })).rejects.toThrow(/Phase 5/);
    await sdk.shutdown();
  });
});
