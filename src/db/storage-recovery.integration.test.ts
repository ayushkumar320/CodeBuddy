import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CodeBuddy } from "../core/codebuddy.js";
import { MemoryFileStore } from "../core/memory-file-store.js";
import { bootstrapDatabase } from "./bootstrap.js";
import { createDatabaseClient } from "./client.js";
import { runMigrations } from "./migrator.js";
import { createPostgresRepository } from "./repository.js";

const databaseUrl = process.env.CODEBUDDY_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describePostgres("Postgres Markdown recovery", () => {
  it("rebuilds deleted fact and summary rows from files", async () => {
    if (!databaseUrl) throw new Error("CODEBUDDY_TEST_DATABASE_URL is required.");
    const root = await mkdtemp(join(tmpdir(), "codebuddy-pg-recovery-"));
    roots.push(root);
    const namespace = `recovery-${Date.now()}`;
    const config = {
      postgresUrl: databaseUrl,
      provider: { type: "huggingface" as const, apiKey: "test" },
      namespace,
      worker: { pollIntervalMs: 60_000 },
    };
    const provider = {
      embed: async () => ({ model: "test", dimensions: 384, vectors: [Array(384).fill(0)] }),
      generateText: async () => ({ model: "test", text: "test" }),
    };

    const firstClient = createDatabaseClient({ postgresUrl: databaseUrl });
    await bootstrapDatabase(firstClient.sql);
    await runMigrations(firstClient);
    const firstRepository = createPostgresRepository(firstClient);
    const first = new CodeBuddy(config, {
      repository: firstRepository,
      provider,
      memoryFileStore: new MemoryFileStore(root),
    });
    await first.init();
    await first.getWorker().stop();
    const fact = await first.remember({ type: "fact", content: "Region is eu-west-1." });
    const summary = await first.remember({
      type: "summary",
      sessionId: "sess_recovery",
      content: "Deployment review completed.",
    });
    await first.shutdown();

    const namespaceRow = await firstRepository.getNamespaceByName(namespace);
    if (!namespaceRow) throw new Error("Expected recovery namespace.");
    await firstClient.sql`delete from embeddings where namespace_id = ${namespaceRow.id}`;
    await firstClient.sql`delete from facts where namespace_id = ${namespaceRow.id}`;
    await firstClient.sql`delete from session_summaries where namespace_id = ${namespaceRow.id}`;
    await firstClient.close();

    const secondClient = createDatabaseClient({ postgresUrl: databaseUrl });
    const secondRepository = createPostgresRepository(secondClient);
    const second = new CodeBuddy(config, {
      repository: secondRepository,
      provider,
      memoryFileStore: new MemoryFileStore(root),
    });
    await second.init();
    await second.getWorker().stop();
    const reindexed = await second.reindexMemory();
    expect(reindexed.facts.imported).toBe(1);
    expect(reindexed.summaries.imported).toBe(1);
    expect(
      (await secondRepository.listFacts({ namespaceId: namespaceRow.id, limit: 10 }))[0]?.id,
    ).toBe(fact.id);
    expect((await secondRepository.getLatestSummary(namespaceRow.id, "sess_recovery"))?.id).toBe(
      summary.id,
    );
    await second.shutdown();
    await secondClient.sql`delete from namespaces where id = ${namespaceRow.id}`;
    await secondClient.close();
  }, 30_000);
});
