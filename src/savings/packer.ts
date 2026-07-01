import { estimateTokens } from "./tokens.js";
import type { PackCandidate, PackedItem, PackResult, PackStats } from "./types.js";

/**
 * Budget-aware packing. Candidates are considered highest-priority first, so the
 * most important evidence is included before anything is dropped — a tight
 * budget sheds low-value context, never the critical findings. When an item does
 * not fit, a smaller rendering is tried before it is skipped. Every decision is
 * recorded with a reason, and the stats expose the compression achieved.
 *
 * Ties are broken by original order, keeping the pack deterministic.
 */
export function packByBudget<T>(candidates: PackCandidate<T>[], budget: number): PackResult<T> {
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      if (right.candidate.priority !== left.candidate.priority) {
        return right.candidate.priority - left.candidate.priority;
      }
      return left.index - right.index;
    });

  const items: PackedItem<T>[] = [];
  let returnedTokens = 0;
  let candidateTokens = 0;
  let included = 0;
  let compressed = 0;
  let skipped = 0;

  for (const { candidate } of ordered) {
    const fullTokens = estimateTokens(candidate.text);
    candidateTokens += fullTokens;

    if (returnedTokens + fullTokens <= budget) {
      returnedTokens += fullTokens;
      included++;
      items.push({
        value: candidate.value,
        status: "included",
        tokens: fullTokens,
        reason: "fits budget",
      });
      continue;
    }

    if (candidate.compressedText !== undefined) {
      const smallTokens = estimateTokens(candidate.compressedText);
      if (returnedTokens + smallTokens <= budget) {
        returnedTokens += smallTokens;
        compressed++;
        items.push({
          value: candidate.value,
          status: "compressed",
          tokens: smallTokens,
          reason: "full text exceeded budget; used compressed form",
        });
        continue;
      }
    }

    skipped++;
    items.push({
      value: candidate.value,
      status: "skipped",
      tokens: 0,
      reason: "did not fit remaining budget",
    });
  }

  const stats: PackStats = {
    budget,
    candidateTokens,
    returnedTokens,
    savedTokens: Math.max(0, candidateTokens - returnedTokens),
    included,
    compressed,
    skipped,
    compressionRatio: candidateTokens > 0 ? Math.min(1, returnedTokens / candidateTokens) : 1,
  };

  // Restore original candidate order for a stable, readable result.
  const originalOrder = new Map(candidates.map((candidate, index) => [candidate.value, index]));
  items.sort(
    (left, right) => (originalOrder.get(left.value) ?? 0) - (originalOrder.get(right.value) ?? 0),
  );

  return { items, stats };
}
