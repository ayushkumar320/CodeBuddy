import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodeBuddy } from "./core/codebuddy.js";
import { checkConfigPermissions, initConfigFile, redactSecrets } from "./core/config-file.js";
import { InMemoryMemoryRepository } from "./core/in-memory-repository.js";
import { listFactsPage, runDoctor } from "./core/operations.js";
import { CodeBuddyNode } from "./langgraph/node.js";
import { mcpToolInputSchemas } from "./mcp/tools/index.js";
import type { ModelProvider } from "./providers/adapter.js";

const provider: ModelProvider = {
  embed: vi.fn(async () => ({
    model: "sentence-transformers/all-MiniLM-L6-v2",
    dimensions: 384,
    vectors: [Array.from({ length: 384 }, () => 0.01)],
  })),
  generateText: vi.fn(async () => ({ model: "stub", text: "ok" })),
};

async function sdk() {
  const repository = new InMemoryMemoryRepository();
  const memory = new CodeBuddy(
    {
      postgresUrl: "postgres://stub",
      provider: { type: "huggingface", apiKey: "secret" },
      namespace: "phase6",
      worker: { pollIntervalMs: 50 },
    },
    { repository, provider },
  );
  await memory.init();
  return { memory, repository };
}

describe("Phase 6 MCP schemas", () => {
  it("accept the documented tool input shapes", () => {
    expect(mcpToolInputSchemas.remember.parse({ content: "x" }).content).toBe("x");
    expect(
      mcpToolInputSchemas.remember_batch.parse({ items: [{ content: "x" }] }).items,
    ).toHaveLength(1);
    expect(mcpToolInputSchemas.recall.parse({ sessionId: "s", query: "q" }).query).toBe("q");
    expect(mcpToolInputSchemas.list_facts.parse({}).limit).toBe(50);
    expect(
      mcpToolInputSchemas.share.parse({ to_namespace: "other", factIds: ["fact_1"] }).mode,
    ).toBeUndefined();
  });

  it("pages list_facts with opaque base64url cursors", async () => {
    const { memory, repository } = await sdk();
    await memory.remember({ content: "a", type: "fact" });
    await memory.remember({ content: "b", type: "fact" });
    const first = await listFactsPage(memory, repository, { limit: 1 });
    expect(first.facts).toHaveLength(1);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.nextCursor).toBeDefined();
    const second = await listFactsPage(memory, repository, {
      limit: 1,
      cursor: first.nextCursor as string,
    });
    expect(second.facts).toHaveLength(1);
    expect(second.facts[0]?.id).not.toBe(first.facts[0]?.id);
    await memory.shutdown();
  });
});

describe("Phase 6 LangGraph helpers", () => {
  it("caches recall by namespace, session, and query", async () => {
    const { memory } = await sdk();
    const recall = vi.spyOn(memory, "recall");
    const node = new CodeBuddyNode({ memory, mode: "recall", cacheTtlSeconds: 30 });
    const state = { sessionId: "sess", messages: [{ content: "what now?" }] };
    await node.invoke(state);
    await node.invoke(state);
    expect(recall).toHaveBeenCalledTimes(1);
    await memory.shutdown();
  });

  it("remember mode writes the latest message", async () => {
    const { memory, repository } = await sdk();
    const node = new CodeBuddyNode({ memory, mode: "remember" });
    await node.invoke({
      sessionId: "sess",
      agentId: "agent-a",
      messages: [{ content: "persist me" }],
    });
    expect(repository.interactions.size).toBe(1);
    await memory.shutdown();
  });
});

describe("Phase 6 config and doctor", () => {
  it("creates config with 0600 permissions and redacts tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codebuddy-"));
    try {
      const result = await initConfigFile(dir);
      const info = await stat(result.path);
      expect((info.mode & 0o777).toString(8)).toBe("600");
      const permissions = await checkConfigPermissions(dir);
      expect(permissions.ok).toBe(true);
      process.env.HF_TOKEN = "hf_secret";
      expect(redactSecrets({ token: "hf_secret", message: "use hf_secret" })).toEqual({
        token: "[REDACTED]",
        message: "use [REDACTED]",
      });
    } finally {
      delete process.env.HF_TOKEN;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports mocked doctor diagnostics", async () => {
    const { repository } = await sdk();
    const report = await runDoctor({
      config: {
        postgresUrl: "postgres://stub",
        provider: { type: "huggingface", apiKey: "secret" },
        namespace: "phase6",
      },
      repository,
      provider,
      skipModelCheck: false,
    });
    expect(report.db.ok).toBe(true);
    expect(report.pgvector.ok).toBe(true);
    expect(report.models.every((model) => model.reachable)).toBe(true);
  });
});
