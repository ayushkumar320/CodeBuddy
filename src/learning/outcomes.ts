import { computeFactHash, generateEntityId } from "../core/ids.js";
import { type IncidentSeverity, MemoryFileStore } from "../core/memory-file-store.js";

export type ChangeOutcome = "safe" | "regression";

export type RecordChangeOutcomeInput = {
  repositoryRoot?: string;
  namespace: string;
  outcome: ChangeOutcome;
  paths: string[];
  summary: string;
  severity?: IncidentSeverity;
  commit?: string;
  planId?: string;
  now?: Date;
};

export type RecordChangeOutcomeResult = {
  id: string;
  path: string;
  category: "general" | "incident";
};

export async function recordChangeOutcome(
  input: RecordChangeOutcomeInput,
): Promise<RecordChangeOutcomeResult> {
  if (input.paths.length === 0) throw new Error("At least one path is required.");
  if (!input.summary.trim()) throw new Error("A non-empty outcome summary is required.");
  const now = input.now ?? new Date();
  const category = input.outcome === "regression" ? "incident" : "general";
  const id = generateEntityId("fact", now.getTime());
  const object = input.outcome === "regression" ? "regression observed" : "verified safe";
  const content = [
    `Change outcome: ${input.outcome}`,
    `Paths: ${input.paths.join(", ")}`,
    `Summary: ${input.summary.trim()}`,
    ...(input.commit ? [`Commit: ${input.commit}`] : []),
  ].join("\n");
  const store = new MemoryFileStore(input.repositoryRoot);
  const path = await store.writeFact({
    id,
    namespace: input.namespace,
    subject: `change outcome for ${input.paths[0]}`,
    predicate: input.outcome === "regression" ? "caused" : "survived",
    object,
    confidence: input.outcome === "regression" ? 0.95 : 0.85,
    createdAt: now.toISOString(),
    createdByAgent: "codebuddy:learn",
    sourceInteractionId: null,
    sourceDeleted: false,
    category,
    paths: input.paths,
    ...(input.outcome === "regression" ? { severity: input.severity ?? "high" } : {}),
    ...(input.commit ? { introducedBy: input.commit } : {}),
    ...(input.planId ? { sourcePlanId: input.planId } : {}),
    verification: ["explicit change outcome recorded by a project owner"],
    fingerprint: computeFactHash(input.namespace, content),
    content,
  });
  return { id, path, category };
}
