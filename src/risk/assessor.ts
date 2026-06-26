import type {
  Assessment,
  AssessmentInput,
  Evidence,
  RiskCategory,
  RiskItem,
  Signal,
  SignalContribution,
  SignalStat,
} from "./types.js";

export type AssessorOptions = {
  /** Items scoring below this are dropped from the result. Default 0. */
  minScore?: number;
};

type ContributionWithSignal = {
  signal: Signal;
  contribution: SignalContribution;
};

/**
 * Runs every enabled signal in parallel and folds their per-path
 * contributions into a single ranked list. Scoring is deterministic: the
 * same inputs and the same cache state always produce the same output, with
 * stable tie-breaking.
 */
export class RiskAssessor {
  private readonly signals: Signal[];
  private readonly minScore: number;

  constructor(signals: Signal[], options: AssessorOptions = {}) {
    this.signals = signals;
    this.minScore = options.minScore ?? 0;
  }

  async assess(input: AssessmentInput): Promise<Assessment> {
    const enabled = this.signals.filter((signal) => signal.enabled);

    const settled = await Promise.all(
      enabled.map(async (signal) => ({
        signal,
        contributions: await signal.assess(input),
      })),
    );

    // Group contributions by path, remembering which signal produced each.
    const byPath = new Map<string, ContributionWithSignal[]>();
    const perSignal = new Map<string, SignalStat>();

    for (const { signal, contributions } of settled) {
      const stat: SignalStat = perSignal.get(signal.id) ?? {
        id: signal.id,
        category: signal.category,
        contributions: 0,
        totalWeight: 0,
      };
      for (const contribution of contributions) {
        // A signal that returns no evidence for a path does not get to vote —
        // the normalization only counts signals that actually have something
        // to say. This keeps a silent signal from diluting a real one.
        if (contribution.evidence.length === 0) continue;
        const list = byPath.get(contribution.path) ?? [];
        list.push({ signal, contribution });
        byPath.set(contribution.path, list);
        stat.contributions += 1;
        stat.totalWeight += contribution.weight;
      }
      perSignal.set(signal.id, stat);
    }

    const items: RiskItem[] = [];
    for (const [path, contributions] of byPath) {
      items.push(this.fold(path, contributions));
    }

    const ranked = items.filter((item) => item.score >= this.minScore).sort(compareRiskItems);

    return {
      items: ranked,
      stats: {
        pathsConsidered: input.paths.length,
        itemsProduced: ranked.length,
        signalsRun: enabled.length,
        perSignal: [...perSignal.values()].sort((a, b) => a.id.localeCompare(b.id)),
      },
    };
  }

  /** Fold all contributions for one path into a single RiskItem. */
  private fold(path: string, contributions: ContributionWithSignal[]): RiskItem {
    let weightedSum = 0;
    let coefficientSum = 0;
    let dominant: ContributionWithSignal | null = null;
    const evidence: Evidence[] = [];
    const contributingSignals: string[] = [];

    for (const entry of contributions) {
      const coefficient = entry.signal.coefficient;
      weightedSum += entry.contribution.weight * coefficient;
      coefficientSum += coefficient;
      evidence.push(...entry.contribution.evidence);
      contributingSignals.push(entry.signal.id);
      if (!dominant || dominantWeight(entry) > dominantWeight(dominant)) {
        dominant = entry;
      }
    }

    // Normalize only over the signals that contributed, so a path is not
    // punished for the signals that stayed silent about it.
    const score = coefficientSum === 0 ? 0 : clip(weightedSum / coefficientSum, 0, 100);
    const category: RiskCategory = dominant?.signal.category ?? "policy";
    const reason = dominant?.contribution.reason ?? "";

    return {
      path,
      score: round2(score),
      category,
      reason,
      contributingSignals: contributingSignals.sort(),
      evidence,
    };
  }
}

function dominantWeight(entry: ContributionWithSignal): number {
  return entry.contribution.weight * entry.signal.coefficient;
}

/** Deterministic ordering: score desc, then more signals, then path asc. */
function compareRiskItems(a: RiskItem, b: RiskItem): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.contributingSignals.length !== a.contributingSignals.length) {
    return b.contributingSignals.length - a.contributingSignals.length;
  }
  return a.path.localeCompare(b.path);
}

function clip(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
