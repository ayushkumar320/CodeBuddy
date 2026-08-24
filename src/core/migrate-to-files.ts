import { createHash } from "node:crypto";
import type { MemoryFileStore } from "./memory-file-store.js";
import type { MemoryRepository } from "./repository.js";

export type MigrationConflict = {
  kind: "fact" | "summary";
  id: string;
  databaseChecksum: string;
  fileChecksum: string;
};

export type MigrationFailure = {
  kind: "fact" | "summary";
  id: string;
  error: string;
};

export type MigrationPreview = {
  namespace: string;
  dryRun: boolean;
  facts: { found: number; existing: number; toWrite: number; conflicts: number; written: number };
  summaries: {
    found: number;
    existing: number;
    toWrite: number;
    conflicts: number;
    written: number;
  };
  conflicts: MigrationConflict[];
  failures: MigrationFailure[];
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
      facts: { found: 0, existing: 0, toWrite: 0, conflicts: 0, written: 0 },
      summaries: { found: 0, existing: 0, toWrite: 0, conflicts: 0, written: 0 },
      conflicts: [],
      failures: [],
    };
  }

  const [facts, summaries, existingFacts, existingSummaries] = await Promise.all([
    input.repository.listFacts({ namespaceId: namespace.id, limit: 100_000 }),
    input.repository.listSummaries({ namespaceId: namespace.id, limit: 100_000 }),
    input.store.listFacts(),
    input.store.listSummaries(),
  ]);
  // The DB reads are hard-capped at 100k rows; a namespace at that ceiling
  // may be silently truncated. Say so instead of implying completeness.
  const warnings =
    facts.length >= 100_000 || summaries.length >= 100_000
      ? [
          "namespace is at or above the 100,000-row read cap; the migration may be partial — prune or export in batches",
        ]
      : [];
  const existingFactsById = new Map(existingFacts.map((fact) => [fact.id, fact]));
  const existingSummariesById = new Map(existingSummaries.map((summary) => [summary.id, summary]));
  const conflicts: MigrationConflict[] = [];
  const failures: MigrationFailure[] = [];
  const factsToWrite = facts.filter((fact) => {
    const existing = existingFactsById.get(fact.id);
    if (!existing) return true;
    const databaseChecksum = checksum(fact.content);
    const fileChecksum = checksum(existing.content);
    if (databaseChecksum !== fileChecksum) {
      conflicts.push({ kind: "fact", id: fact.id, databaseChecksum, fileChecksum });
    }
    return false;
  });
  const summariesToWrite = summaries.filter((summary) => {
    const existing = existingSummariesById.get(summary.id);
    if (!existing) return true;
    const databaseChecksum = checksum(summary.content);
    const fileChecksum = checksum(existing.content);
    if (databaseChecksum !== fileChecksum) {
      conflicts.push({ kind: "summary", id: summary.id, databaseChecksum, fileChecksum });
    }
    return false;
  });
  let factsWritten = 0;
  let summariesWritten = 0;

  if (input.write) {
    for (const fact of factsToWrite) {
      try {
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
        factsWritten += 1;
      } catch (error) {
        failures.push({ kind: "fact", id: fact.id, error: (error as Error).message });
      }
    }
    for (const summary of summariesToWrite) {
      try {
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
        summariesWritten += 1;
      } catch (error) {
        failures.push({ kind: "summary", id: summary.id, error: (error as Error).message });
      }
    }
  }

  const factConflicts = conflicts.filter((conflict) => conflict.kind === "fact").length;
  const summaryConflicts = conflicts.length - factConflicts;
  return {
    namespace: input.namespace,
    dryRun: !input.write,
    ...(warnings.length > 0 ? { warnings } : {}),
    facts: {
      found: facts.length,
      existing: facts.length - factsToWrite.length - factConflicts,
      toWrite: factsToWrite.length,
      conflicts: factConflicts,
      written: factsWritten,
    },
    summaries: {
      found: summaries.length,
      existing: summaries.length - summariesToWrite.length - summaryConflicts,
      toWrite: summariesToWrite.length,
      conflicts: summaryConflicts,
      written: summariesWritten,
    },
    conflicts,
    failures,
  };
}

function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
