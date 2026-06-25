import type { MemoryFileStore } from "./memory-file-store.js";
import type { MemoryRepository } from "./repository.js";

export type MigrationPreview = {
  namespace: string;
  dryRun: boolean;
  facts: { found: number; existing: number; toWrite: number };
  summaries: { found: number; existing: number; toWrite: number };
};

export async function migrateMemoryToFiles(input: {
  repository: MemoryRepository;
  store: MemoryFileStore;
  namespace: string;
  write: boolean;
}): Promise<MigrationPreview> {
  const namespace = await input.repository.getNamespaceByName(input.namespace);
  if (!namespace) {
    return {
      namespace: input.namespace,
      dryRun: !input.write,
      facts: { found: 0, existing: 0, toWrite: 0 },
      summaries: { found: 0, existing: 0, toWrite: 0 },
    };
  }

  const [facts, summaries, existingFacts, existingSummaries] = await Promise.all([
    input.repository.listFacts({ namespaceId: namespace.id, limit: 100_000 }),
    input.repository.listSummaries({ namespaceId: namespace.id, limit: 100_000 }),
    input.store.listFacts(),
    input.store.listSummaries(),
  ]);
  const existingFactIds = new Set(existingFacts.map((fact) => fact.id));
  const existingSummaryIds = new Set(existingSummaries.map((summary) => summary.id));
  const factsToWrite = facts.filter((fact) => !existingFactIds.has(fact.id));
  const summariesToWrite = summaries.filter((summary) => !existingSummaryIds.has(summary.id));

  if (input.write) {
    for (const fact of factsToWrite) {
      await input.store.writeFact({
        id: fact.id,
        namespace: input.namespace,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        confidence: fact.confidence,
        createdAt: fact.createdAt.toISOString(),
        createdByAgent: fact.createdByAgent,
        sourceInteractionId: fact.sourceInteractionId,
        sourceDeleted: fact.sourceDeleted,
        content: fact.content,
      });
    }
    for (const summary of summariesToWrite) {
      await input.store.writeSummary({
        id: summary.id,
        namespace: input.namespace,
        sessionId: summary.sessionId,
        version: summary.version,
        tokenCount: summary.tokenCount,
        createdAt: summary.createdAt.toISOString(),
        createdByAgent: summary.createdByAgent,
        content: summary.content,
      });
    }
  }

  return {
    namespace: input.namespace,
    dryRun: !input.write,
    facts: {
      found: facts.length,
      existing: facts.length - factsToWrite.length,
      toWrite: factsToWrite.length,
    },
    summaries: {
      found: summaries.length,
      existing: summaries.length - summariesToWrite.length,
      toWrite: summariesToWrite.length,
    },
  };
}
