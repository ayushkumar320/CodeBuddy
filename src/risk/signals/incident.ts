import type { IncidentSeverity, MemoryFileStore } from "../../core/memory-file-store.js";
import type { Signal, SignalContribution } from "../types.js";

export type IncidentSignalOptions = {
  store: MemoryFileStore;
  enabled?: boolean;
  coefficient?: number;
  includeResolved?: boolean;
};

/**
 * Historical incident signal (Proposal 03.2/03.5 foundation). It reads
 * structured incident metadata from Markdown facts and produces one
 * evidence-backed contribution per affected path.
 */
export function createIncidentSignal(options: IncidentSignalOptions): Signal {
  return {
    id: "incident-memory",
    category: "incident",
    enabled: options.enabled ?? true,
    coefficient: options.coefficient ?? 1.2,
    async assess(input) {
      const incidents = await options.store.findIncidentFactsForPaths({
        namespace: input.namespace,
        paths: input.paths,
        includeResolved: options.includeResolved ?? false,
      });

      const byPath = new Map<string, SignalContribution>();
      for (const incident of incidents) {
        for (const path of input.paths) {
          if (!incident.paths.map(normalizePath).includes(normalizePath(path))) continue;
          const existing = byPath.get(path);
          const evidence = {
            kind: "memory_fact" as const,
            factId: incident.id,
            content: incident.content,
            createdAt: incident.createdAt,
          };
          if (!existing) {
            byPath.set(path, {
              path,
              weight: severityWeight(incident.severity),
              reason: `This file is linked to prior ${incident.severity} incident memory.`,
              evidence: [evidence],
            });
            continue;
          }
          existing.weight = Math.max(existing.weight, severityWeight(incident.severity));
          existing.reason = `This file is linked to ${existing.evidence.length + 1} prior incident memories.`;
          existing.evidence.push(evidence);
        }
      }

      return [...byPath.values()];
    },
  };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function severityWeight(severity: IncidentSeverity): number {
  switch (severity) {
    case "critical":
      return 95;
    case "high":
      return 80;
    case "medium":
      return 55;
    case "low":
      return 30;
  }
}
