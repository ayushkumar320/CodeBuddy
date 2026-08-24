import { bootstrapDatabase, checkPgvector } from "../db/bootstrap.js";
import { createDatabaseClient, pingDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrator.js";
import { createPostgresRepository } from "../db/repository.js";
import type { ModelProvider } from "../providers/adapter.js";
import { DEFAULT_EMBEDDING_MODELS, DEFAULT_LLM_MODELS } from "../providers/models.js";
import { CodeBuddy } from "./codebuddy.js";
import {
  checkConfigPermissions,
  checkProjectScaffold,
  defaultNamespaceForCwd,
  loadRuntimeConfig,
  readConfigFile,
  redactSecrets,
} from "./config-file.js";
import { MemoryFileStore } from "./memory-file-store.js";
import type { MemoryRepository } from "./repository.js";
import type { CodeBuddyConfig } from "./types.js";

export type RuntimeHandle = {
  memory: CodeBuddy;
  repository: MemoryRepository;
  close(): Promise<void>;
};

export type CreateRuntimeOptions = {
  /**
   * When true (default for `serve`), enable pgvector and apply any pending
   * SQL migrations before the SDK initialises. Safe to run repeatedly —
   * Drizzle skips migrations it has already applied.
   */
  autoBootstrap?: boolean;
  repositoryRoot?: string;
};

export async function createRuntime(
  config?: CodeBuddyConfig,
  options: CreateRuntimeOptions = {},
): Promise<RuntimeHandle> {
  const runtimeConfig = config ?? (await loadRuntimeConfig());
  const client = createDatabaseClient({ postgresUrl: runtimeConfig.postgresUrl });
  if (options.autoBootstrap) {
    await bootstrapDatabase(client.sql);
    await runMigrations(client);
  }
  const repository = createPostgresRepository(client);
  const memory = new CodeBuddy(runtimeConfig, {
    repository,
    memoryFileStore: new MemoryFileStore(
      options.repositoryRoot ?? runtimeConfig.projectRoot ?? process.cwd(),
    ),
  });
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid cursor: expected a base64url-encoded [createdAt, id] pair.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    Number.isNaN(Date.parse(parsed[0]))
  ) {
    throw new Error("Invalid cursor: expected a base64url-encoded [createdAt, id] pair.");
  }
  const [createdAt, id] = parsed as [string, string];
  return { createdAt: new Date(createdAt), id };
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
  db: { ok: boolean; error?: string; canConnect?: boolean; postgresUrlSource?: string };
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
  scaffold: Awaited<ReturnType<typeof checkProjectScaffold>>;
  config: Awaited<ReturnType<typeof checkConfigPermissions>>;
  namespace: {
    expectedDefault: string;
    configured: string | null;
    runtime: string | null;
    ok: boolean;
    warning?: string;
  };
};

export async function runDoctor(
  options: {
    config?: CodeBuddyConfig;
    repository?: MemoryRepository;
    provider?: ModelProvider;
    skipModelCheck?: boolean;
  } = {},
): Promise<DoctorReport> {
  const fileConfig = await readConfigFile();
  const scaffold = await checkProjectScaffold();
  const configPermissions = await checkConfigPermissions();
  // Same helper the runtime and every CLI command use — one rule everywhere.
  const expectedDefaultNamespace = defaultNamespaceForCwd();
  const runtimeNamespace =
    process.env.CODEBUDDY_NAMESPACE ?? fileConfig.namespace ?? options.config?.namespace ?? null;
  const namespaceReport: DoctorReport["namespace"] = {
    expectedDefault: expectedDefaultNamespace,
    configured: fileConfig.namespace ?? null,
    runtime: runtimeNamespace,
    ok:
      !fileConfig.namespace ||
      fileConfig.namespace === expectedDefaultNamespace ||
      process.env.CODEBUDDY_NAMESPACE !== undefined,
    ...(!fileConfig.namespace ||
    fileConfig.namespace === expectedDefaultNamespace ||
    process.env.CODEBUDDY_NAMESPACE !== undefined
      ? {}
      : {
          warning: `Configured namespace "${fileConfig.namespace}" differs from this folder's default "${expectedDefaultNamespace}". Confirm your MCP entries point at the intended namespace.`,
        }),
  };

  let config = options.config;
  if (!config) {
    try {
      config = await loadRuntimeConfig();
    } catch (error) {
      const message = String(redactSecrets((error as Error).message));
      return {
        db: {
          ok: false,
          error: message,
          canConnect: false,
          postgresUrlSource: "missing",
        },
        pgvector: { ok: false, error: "Postgres is not configured yet." },
        vectors: { count: 0, index: null, needsTuning: false },
        models: await checkModels(options.provider, true),
        usage: {
          last60s: 0,
          lastHour: 0,
          last24h: 0,
          estimatedDailyCapRemaining: 10_000,
          warning80Percent: false,
        },
        scaffold,
        config: configPermissions,
        namespace: namespaceReport,
      };
    }
  }

  let repository = options.repository;
  let close: (() => Promise<void>) | undefined;
  let db = { ok: true } as DoctorReport["db"];
  let pgvector = { ok: true } as DoctorReport["pgvector"];

  if (!repository) {
    const postgresUrlSource =
      options.config?.postgresUrl !== undefined
        ? "explicit"
        : process.env.DATABASE_URL
          ? "environment"
          : fileConfig.postgresUrl
            ? "config"
            : "missing";
    const client = createDatabaseClient({ postgresUrl: config.postgresUrl });
    repository = createPostgresRepository(client);
    close = () => client.close();
    try {
      const canConnect = await pingDatabase(client);
      db = { ok: canConnect, canConnect, postgresUrlSource };
      if (!canConnect) db.error = "Postgres did not respond to a simple ping.";
    } catch (error) {
      db = {
        ok: false,
        canConnect: false,
        postgresUrlSource,
        error: String(redactSecrets((error as Error).message)),
      };
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
        scaffold,
        config: configPermissions,
        namespace: namespaceReport,
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
      scaffold,
      config: configPermissions,
      namespace: namespaceReport,
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
