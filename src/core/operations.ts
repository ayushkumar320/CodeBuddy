import { checkPgvector } from "../db/bootstrap.js";
import { createDatabaseClient, pingDatabase } from "../db/client.js";
import { createPostgresRepository } from "../db/repository.js";
import type { ModelProvider } from "../providers/adapter.js";
import { DEFAULT_EMBEDDING_MODELS, DEFAULT_LLM_MODELS } from "../providers/models.js";
import { CodeBuddy } from "./codebuddy.js";
import { checkConfigPermissions, loadRuntimeConfig, redactSecrets } from "./config-file.js";
import type { MemoryRepository } from "./repository.js";
import type { CodeBuddyConfig } from "./types.js";

export type RuntimeHandle = {
  memory: CodeBuddy;
  repository: MemoryRepository;
  close(): Promise<void>;
};

export async function createRuntime(config?: CodeBuddyConfig): Promise<RuntimeHandle> {
  const runtimeConfig = config ?? (await loadRuntimeConfig());
  const client = createDatabaseClient({ postgresUrl: runtimeConfig.postgresUrl });
  const repository = createPostgresRepository(client);
  const memory = new CodeBuddy(runtimeConfig, { repository });
  await memory.init();
  return {
    memory,
    repository,
    async close() {
      await memory.shutdown();
      await client.close();
    },
  };
}

export function encodeFactCursor(fact: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([fact.createdAt.toISOString(), fact.id]), "utf8").toString(
    "base64url",
  );
}

export function decodeFactCursor(cursor: string): { createdAt: Date; id: string } {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [string, string];
  return { createdAt: new Date(parsed[0]), id: parsed[1] };
}

export async function listFactsPage(
  memory: CodeBuddy,
  repository: MemoryRepository,
  input: { subject?: string; limit?: number; cursor?: string },
) {
  const namespace = await repository.ensureNamespace(memory.config.namespace);
  const requestedLimit = input.limit ?? 50;
  const limit = Math.max(1, Math.min(100, requestedLimit));
  const facts = await repository.listFacts({
    namespaceId: namespace.id,
    ...(input.subject ? { subject: input.subject } : {}),
    limit: limit + 1,
    ...(input.cursor ? { cursor: decodeFactCursor(input.cursor) } : {}),
  });
  const page = facts.slice(0, limit);
  const next = facts.length > limit ? page.at(-1) : undefined;
  return {
    facts: page,
    ...(next ? { nextCursor: encodeFactCursor(next) } : {}),
  };
}

export async function inspectNamespace(repository: MemoryRepository, namespace?: string) {
  if (!namespace) {
    return {
      namespaces: await repository.listNamespaces(),
      agents: await repository.getAgentWriteBreakdown(),
    };
  }
  const row = await repository.getNamespaceByName(namespace);
  if (!row) return { namespace, exists: false, facts: [], agents: [] };
  return {
    namespace,
    exists: true,
    facts: await repository.listFacts({ namespaceId: row.id, limit: 50 }),
    agents: await repository.getAgentWriteBreakdown(row.id),
  };
}

export type DoctorReport = {
  db: { ok: boolean; error?: string };
  pgvector: { ok: boolean; error?: string };
  vectors: { count: number; index: string | null; needsTuning: boolean };
  models: {
    id: string;
    reachable: boolean;
    status: "unknown" | "warm" | "cold" | "gated" | "failed";
    error?: string;
  }[];
  usage: {
    last60s: number;
    lastHour: number;
    last24h: number;
    estimatedDailyCapRemaining: number;
    warning80Percent: boolean;
  };
  config: Awaited<ReturnType<typeof checkConfigPermissions>>;
};

export async function runDoctor(
  options: {
    config?: CodeBuddyConfig;
    repository?: MemoryRepository;
    provider?: ModelProvider;
    skipModelCheck?: boolean;
  } = {},
): Promise<DoctorReport> {
  const config = options.config ?? (await loadRuntimeConfig());
  let repository = options.repository;
  let close: (() => Promise<void>) | undefined;
  let db = { ok: true } as DoctorReport["db"];
  let pgvector = { ok: true } as DoctorReport["pgvector"];

  if (!repository) {
    const client = createDatabaseClient({ postgresUrl: config.postgresUrl });
    repository = createPostgresRepository(client);
    close = () => client.close();
    try {
      db = { ok: await pingDatabase(client) };
    } catch (error) {
      db = { ok: false, error: String(redactSecrets((error as Error).message)) };
    }
    try {
      const health = await checkPgvector(client.sql);
      pgvector = {
        ok: health.available,
        ...(health.available ? {} : { error: "pgvector extension is not installed." }),
      };
    } catch (error) {
      pgvector = { ok: false, error: String(redactSecrets((error as Error).message)) };
    }
  }

  try {
    if (!db.ok) {
      return {
        db,
        pgvector,
        vectors: { count: 0, index: null, needsTuning: false },
        models: await checkModels(options.provider, true),
        usage: {
          last60s: 0,
          lastHour: 0,
          last24h: 0,
          estimatedDailyCapRemaining: 10_000,
          warning80Percent: false,
        },
        config: await checkConfigPermissions(),
      };
    }
    const namespace = await repository.ensureNamespace(config.namespace);
    const [stats, vectorHealth] = await Promise.all([
      repository.getStats(namespace.id),
      repository.getVectorIndexHealth(namespace.id),
    ]);
    const models = await checkModels(options.provider, options.skipModelCheck);
    const dailyCap = 10_000;
    const used = stats.modelCalls.last24h;
    return {
      db,
      pgvector,
      vectors: {
        count: vectorHealth.vectorCount,
        index: vectorHealth.indexName,
        needsTuning: vectorHealth.needsTuning,
      },
      models,
      usage: {
        last60s: stats.modelCalls.last60s,
        lastHour: stats.modelCalls.lastHour,
        last24h: used,
        estimatedDailyCapRemaining: Math.max(0, dailyCap - used),
        warning80Percent: used >= dailyCap * 0.8,
      },
      config: await checkConfigPermissions(),
    };
  } finally {
    await close?.();
  }
}

async function checkModels(
  provider?: ModelProvider,
  skip = false,
): Promise<DoctorReport["models"]> {
  const ids = [...DEFAULT_EMBEDDING_MODELS, ...DEFAULT_LLM_MODELS].map((model) => model.id);
  if (!provider || skip) {
    return ids.map((id) => ({ id, reachable: false, status: "unknown" }));
  }
  const results: DoctorReport["models"] = [];
  for (const id of ids) {
    try {
      if (DEFAULT_EMBEDDING_MODELS.some((model) => model.id === id)) {
        await provider.embed({ model: id, input: "doctor" });
      } else {
        await provider.generateText({ model: id, prompt: "doctor" });
      }
      results.push({ id, reachable: true, status: "warm" });
    } catch (error) {
      const message = String(redactSecrets((error as Error).message));
      results.push({
        id,
        reachable: false,
        status: /gated|403/i.test(message)
          ? "gated"
          : /cold|503/i.test(message)
            ? "cold"
            : "failed",
        error: message,
      });
    }
  }
  return results;
}
