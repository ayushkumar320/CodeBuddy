import { clampBudgetForCallerModel } from "../planner/budget.js";
import { DefaultPolicy } from "../planner/default-policy.js";
import type { ContextPolicy, PlanInput } from "../planner/types.js";
import type { ModelProvider } from "../providers/adapter.js";
import { HuggingFaceProvider } from "../providers/huggingface.js";
import { DEFAULT_EMBEDDING_MODELS } from "../providers/models.js";
import { createTracer, type Tracer } from "../tracing/langsmith.js";
import { type ValidatedCodeBuddyConfig, validateConfig } from "./config.js";
import {
  computeContentHash,
  computeFactHash,
  generateEntityId,
  generateSessionId,
  generateUlid,
} from "./ids.js";
import type { FactFile, MemoryFileStore } from "./memory-file-store.js";
import type {
  AuditEntry,
  FactInsert,
  InteractionInsert,
  MemoryRepository,
  PendingEmbeddingInsert,
  ShareWriteInput,
  SummaryInsert,
  WriteResult,
} from "./repository.js";
import type {
  CodeBuddyConfig,
  CodeBuddyStatus,
  ForgetResult,
  MemoryWriteType,
  RecallInput,
  RecallResult,
  RememberBatchItem,
  RememberInput,
  RememberResult,
  ShareInput,
  ShareResult,
} from "./types.js";
import { EmbeddingWorker } from "./worker.js";

export type CodeBuddyDependencies = {
  repository: MemoryRepository;
  memoryFileStore?: MemoryFileStore;
  provider?: ModelProvider;
  worker?: EmbeddingWorker;
  policy?: ContextPolicy;
  tracer?: Tracer;
};

export class CodeBuddy {
  readonly config: ValidatedCodeBuddyConfig;
  private readonly repo: MemoryRepository;
  private readonly provider: ModelProvider;
  private readonly worker: EmbeddingWorker;
  private readonly policy: ContextPolicy;
  private readonly tracer: Tracer;
  private readonly memoryFileStore: MemoryFileStore | undefined;
  private namespaceId: string | null = null;
  private initialized = false;

  constructor(config: CodeBuddyConfig, deps?: CodeBuddyDependencies) {
    this.config = validateConfig(config);
    if (!deps?.repository) {
      throw new Error(
        "CodeBuddy requires a MemoryRepository. Pass deps.repository (use createPostgresRepository for production).",
      );
    }
    this.repo = deps.repository;
    this.memoryFileStore = deps.memoryFileStore;
    this.provider = deps.provider ?? buildProviderFromConfig(this.config.provider);
    this.worker =
      deps.worker ??
      new EmbeddingWorker({
        repository: this.repo,
        provider: this.provider,
        ...(this.config.worker?.pollIntervalMs !== undefined
          ? { pollIntervalMs: this.config.worker.pollIntervalMs }
          : {}),
        ...(this.config.worker?.batchSize !== undefined
          ? { batchSize: this.config.worker.batchSize }
          : {}),
        ...(this.config.worker?.maxAttempts !== undefined
          ? { maxAttempts: this.config.worker.maxAttempts }
          : {}),
      });
    this.policy = deps.policy ?? new DefaultPolicy();
    this.tracer = deps.tracer ?? createTracer();
  }

  async init(): Promise<CodeBuddyStatus> {
    const namespace = await this.repo.ensureNamespace(this.config.namespace);
    this.namespaceId = namespace.id;
    this.initialized = true;
    this.worker.start();
    return {
      ready: true,
      phase: "runtime",
      message: `CodeBuddy ready in namespace ${namespace.name}.`,
      namespaceId: namespace.id,
    };
  }

  async shutdown(): Promise<void> {
    await this.worker.shutdown();
  }

  getWorker(): EmbeddingWorker {
    return this.worker;
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    const namespaceId = this.requireNamespaceId();
    const type: MemoryWriteType = input.type ?? "interaction";
    const sessionId = input.sessionId ?? generateSessionId();
    const content = input.content;
    if (!content || content.length === 0) {
      throw new Error("remember: content must not be empty.");
    }
    const result = await this.repo.withSessionLock(namespaceId, sessionId, () =>
      this.writeOne({
        namespaceId,
        sessionId,
        type,
        content,
        idempotencyKey: input.idempotencyKey,
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      }),
    );
    this.worker.notify();
    return {
      id: result.id,
      sessionId: result.sessionId,
      deduplicated: result.deduplicated,
    };
  }

  async rememberBatch(items: RememberBatchItem[]): Promise<RememberResult[]> {
    if (!Array.isArray(items) || items.length === 0) return [];
    const results: RememberResult[] = [];
    for (const item of items) {
      results.push(await this.remember(item));
    }
    return results;
  }

  async recall(input: RecallInput): Promise<RecallResult> {
    const namespaceId = this.requireNamespaceId();
    if (!input.query || input.query.length === 0) {
      throw new Error("recall: query must not be empty.");
    }
    const requested = input.budget ?? this.config.tokenBudget ?? 4_000;
    const clamp = clampBudgetForCallerModel(requested, input.callerModel);
    const queryEmbedding = await this.embedQueryWithFallback(input.query);
    const planInput: PlanInput = {
      namespace: this.config.namespace,
      namespaceId,
      sessionId: input.sessionId,
      query: input.query,
      budget: clamp.budget,
      conflictMode: input.conflictMode ?? "all",
      queryEmbedding,
      repository: this.repo,
      ...(input.callerModel !== undefined ? { callerModel: input.callerModel } : {}),
    };

    const planned = await this.tracer.withSpan(
      "codebuddy.recall",
      {
        namespace: this.config.namespace,
        sessionId: input.sessionId,
        budget: clamp.budget,
        conflictMode: planInput.conflictMode,
        callerModel: input.callerModel ?? null,
      },
      () => this.policy.plan(planInput),
    );

    planned.stats.budgetClamped = clamp.clamped;
    if (clamp.clamped && clamp.reason) {
      planned.stats.budgetClampReason = clamp.reason;
    }
    return planned;
  }

  private async embedQueryWithFallback(query: string): Promise<number[] | null> {
    try {
      const response = await this.tracer.withSpan(
        "codebuddy.recall.embed_query",
        { length: query.length },
        () => this.provider.embed({ input: query }),
      );
      return response.vectors[0] ?? null;
    } catch {
      return null;
    }
  }

  async share(input: ShareInput): Promise<ShareResult> {
    if (!input.from || !input.to) {
      throw new Error("share: both 'from' and 'to' namespaces are required.");
    }
    if (input.from === input.to) {
      throw new Error("share: 'from' and 'to' must differ.");
    }
    if (!Array.isArray(input.factIds) || input.factIds.length === 0) {
      return { shared: 0 };
    }
    const mode = input.mode ?? "reference";
    const fromNs = await this.repo.ensureNamespace(input.from);
    const toNs = await this.repo.ensureNamespace(input.to);
    let shared = 0;
    const embeddingModel = DEFAULT_EMBEDDING_MODELS[0]?.id ?? "unknown";

    for (const factId of input.factIds) {
      const auditId = generateEntityId("aud");
      const shareId = generateEntityId("shr");
      if (mode === "reference") {
        const write: ShareWriteInput = {
          id: shareId,
          fromNamespaceId: fromNs.id,
          toNamespaceId: toNs.id,
          sourceFactId: factId,
          mode: "reference",
          ...(input.agentId !== undefined ? { createdByAgent: input.agentId } : {}),
        };
        await this.repo.shareReference(write);
      } else {
        const snapshotFactId = generateEntityId("fact");
        const snapshotEmbeddingId = generateEntityId("emb");
        const snapshotFact: FactInsert = {
          id: snapshotFactId,
          namespaceId: toNs.id,
          content: `__snapshot:${factId}`,
          contentHash: computeFactHash(toNs.name, `__snapshot:${factId}:${shareId}`),
          subject: "__shared__",
          predicate: "snapshot_of",
          object: factId,
          ...(input.agentId !== undefined ? { createdByAgent: input.agentId } : {}),
        };
        const embedding: PendingEmbeddingInsert = {
          id: snapshotEmbeddingId,
          namespaceId: toNs.id,
          ownerType: "fact",
          ownerId: snapshotFactId,
          embeddingModel,
        };
        const write: ShareWriteInput = {
          id: shareId,
          fromNamespaceId: fromNs.id,
          toNamespaceId: toNs.id,
          sourceFactId: factId,
          mode: "snapshot",
          snapshotFactId,
          ...(input.agentId !== undefined ? { createdByAgent: input.agentId } : {}),
        };
        await this.repo.shareSnapshot({ share: write, snapshotFact, embedding });
      }
      const audit: AuditEntry = {
        id: auditId,
        namespaceId: fromNs.id,
        action: "share",
        entityType: "fact",
        entityId: factId,
        ...(input.agentId !== undefined ? { createdByAgent: input.agentId } : {}),
        metadata: { mode, toNamespace: toNs.name, shareId },
      };
      await this.repo.recordAudit(audit);
      shared += 1;
    }
    this.worker.notify();
    return { shared };
  }

  async forget(id: string): Promise<ForgetResult> {
    if (!id) throw new Error("forget: id is required.");
    const namespaceId = this.requireNamespaceId();
    const interactionAudit: AuditEntry = {
      id: generateEntityId("aud"),
      namespaceId,
      action: "forget",
      entityType: "interaction",
      entityId: id,
    };
    const interactionResult = await this.repo.forgetInteraction(id, interactionAudit);
    if (interactionResult.found) {
      return { ok: true, entityType: "interaction" };
    }
    const factAudit: AuditEntry = {
      id: generateEntityId("aud"),
      namespaceId,
      action: "forget",
      entityType: "fact",
      entityId: id,
    };
    const factResult = await this.repo.forgetFact(id, factAudit);
    if (factResult.found) {
      await this.memoryFileStore?.deleteFact(id);
      return { ok: true, entityType: "fact" };
    }
    return { ok: false, entityType: "unknown" };
  }

  async reindexFacts(): Promise<{ scanned: number; imported: number; deduplicated: number }> {
    const namespaceId = this.requireNamespaceId();
    if (!this.memoryFileStore) {
      throw new Error("Fact reindexing requires a repository-rooted MemoryFileStore.");
    }
    const facts = await this.memoryFileStore.listFacts();
    let imported = 0;
    let deduplicated = 0;
    for (const fact of facts) {
      if (fact.namespace !== this.config.namespace) continue;
      const result = await this.importFactFile(namespaceId, fact);
      if (result.deduplicated) deduplicated += 1;
      else imported += 1;
    }
    this.worker.notify();
    return { scanned: facts.length, imported, deduplicated };
  }

  private requireNamespaceId(): string {
    if (!this.initialized || !this.namespaceId) {
      throw new Error("CodeBuddy.init() must complete before this method is called.");
    }
    return this.namespaceId;
  }

  private async writeOne(input: {
    namespaceId: string;
    sessionId: string;
    type: MemoryWriteType;
    content: string;
    idempotencyKey?: string | undefined;
    agentId?: string | undefined;
  }): Promise<WriteResult> {
    const contentHash =
      input.idempotencyKey ??
      (input.type === "fact"
        ? computeFactHash(this.config.namespace, input.content)
        : computeContentHash(this.config.namespace, input.sessionId, input.content));
    const tokenCount = estimateTokenCount(input.content);
    const embeddingModel = DEFAULT_EMBEDDING_MODELS[0]?.id ?? "unknown";
    const ownerId = generateEntityId(prefixForType(input.type));
    const embeddingId = generateEntityId("emb");
    const embedding: PendingEmbeddingInsert = {
      id: embeddingId,
      namespaceId: input.namespaceId,
      ownerType: input.type,
      ownerId,
      embeddingModel,
    };
    const audit: AuditEntry = {
      id: generateEntityId("aud"),
      namespaceId: input.namespaceId,
      action: "remember",
      entityType: input.type,
      entityId: ownerId,
      ...(input.agentId !== undefined ? { createdByAgent: input.agentId } : {}),
      metadata: { sessionId: input.sessionId, type: input.type },
    };

    if (input.type === "interaction") {
      const interaction: InteractionInsert = {
        id: ownerId,
        namespaceId: input.namespaceId,
        sessionId: input.sessionId,
        content: input.content,
        contentHash,
        tokenCount,
        ...(input.agentId !== undefined ? { createdByAgent: input.agentId } : {}),
      };
      return this.repo.writeInteraction({ interaction, embedding, audit });
    }
    if (input.type === "fact") {
      const fact: FactInsert = {
        id: ownerId,
        namespaceId: input.namespaceId,
        content: input.content,
        contentHash,
        subject: "__inline__",
        predicate: "asserts",
        object: input.content.slice(0, 200),
        ...(input.agentId !== undefined ? { createdByAgent: input.agentId } : {}),
      };
      const result = await this.repo.writeFact({ fact, embedding, audit });
      if (this.memoryFileStore) {
        if (result.deduplicated) {
          try {
            await this.memoryFileStore.readFact(result.id);
            return result;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        await this.memoryFileStore.writeFact({
          id: result.id,
          namespace: this.config.namespace,
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
          confidence: 1,
          createdAt: new Date().toISOString(),
          createdByAgent: input.agentId ?? null,
          sourceInteractionId: fact.sourceInteractionId ?? null,
          sourceDeleted: false,
          content: fact.content,
        });
      }
      return result;
    }
    const summary: SummaryInsert = {
      id: ownerId,
      namespaceId: input.namespaceId,
      sessionId: input.sessionId,
      content: input.content,
      tokenCount,
      ...(input.agentId !== undefined ? { createdByAgent: input.agentId } : {}),
    };
    return this.repo.writeSummary({ summary, embedding, audit });
  }

  private async importFactFile(namespaceId: string, file: FactFile): Promise<WriteResult> {
    const embeddingModel = DEFAULT_EMBEDDING_MODELS[0]?.id ?? "unknown";
    const fact: FactInsert = {
      id: file.id,
      namespaceId,
      content: file.content,
      contentHash: computeFactHash(this.config.namespace, file.content),
      subject: file.subject,
      predicate: file.predicate,
      object: file.object,
      ...(file.sourceInteractionId ? { sourceInteractionId: file.sourceInteractionId } : {}),
      ...(file.createdByAgent ? { createdByAgent: file.createdByAgent } : {}),
    };
    return this.repo.writeFact({
      fact,
      embedding: {
        id: generateEntityId("emb"),
        namespaceId,
        ownerType: "fact",
        ownerId: file.id,
        embeddingModel,
      },
      audit: {
        id: generateEntityId("aud"),
        namespaceId,
        action: "remember",
        entityType: "fact",
        entityId: file.id,
        metadata: { source: "reindex", path: file.path },
      },
    });
  }
}

function prefixForType(type: MemoryWriteType): string {
  if (type === "interaction") return "int";
  if (type === "fact") return "fact";
  return "sum";
}

function estimateTokenCount(content: string): number {
  if (!content) return 0;
  return Math.max(1, Math.ceil(content.length / 4));
}

export function newEntityId(prefix: string): string {
  return `${prefix}_${generateUlid().toLowerCase()}`;
}

function buildProviderFromConfig(provider: ValidatedCodeBuddyConfig["provider"]): ModelProvider {
  return new HuggingFaceProvider(provider.apiKey ? { apiKey: provider.apiKey } : {});
}
