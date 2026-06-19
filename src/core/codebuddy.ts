import type { ModelProvider } from "../providers/adapter.js";
import { HuggingFaceProvider } from "../providers/huggingface.js";
import { DEFAULT_EMBEDDING_MODELS } from "../providers/models.js";
import { type ValidatedCodeBuddyConfig, validateConfig } from "./config.js";
import {
  computeContentHash,
  computeFactHash,
  generateEntityId,
  generateSessionId,
  generateUlid,
} from "./ids.js";
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
  provider?: ModelProvider;
  worker?: EmbeddingWorker;
};

export class CodeBuddy {
  readonly config: ValidatedCodeBuddyConfig;
  private readonly repo: MemoryRepository;
  private readonly provider: ModelProvider;
  private readonly worker: EmbeddingWorker;
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
    this.provider =
      deps.provider ??
      new HuggingFaceProvider(
        this.config.provider.apiKey ? { apiKey: this.config.provider.apiKey } : {},
      );
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

  async recall(_input: RecallInput): Promise<RecallResult> {
    this.requireNamespaceId();
    throw new Error("CodeBuddy.recall is implemented in Phase 5 (planner + budget packing).");
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
      return { ok: true, entityType: "fact" };
    }
    return { ok: false, entityType: "unknown" };
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
      return this.repo.writeFact({ fact, embedding, audit });
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
