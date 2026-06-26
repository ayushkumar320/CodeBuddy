import { describe, expect, it } from "vitest";
import { RiskAssessor } from "./assessor.js";
import type {
  AssessmentInput,
  Evidence,
  RiskCategory,
  Signal,
  SignalContribution,
} from "./types.js";

const input: AssessmentInput = {
  paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
  repositoryRoot: "/repo",
  namespace: "demo",
};

function fakeEvidence(): Evidence[] {
  return [{ kind: "policy_rule", ruleId: "r1", pattern: "src/**" }];
}

function fakeSignal(
  id: string,
  category: RiskCategory,
  coefficient: number,
  contributions: Array<Partial<SignalContribution> & { path: string; weight: number }>,
  enabled = true,
): Signal {
  return {
    id,
    category,
    coefficient,
    enabled,
    assess: async () =>
      contributions.map((c) => ({
        path: c.path,
        weight: c.weight,
        reason: c.reason ?? `${id} flagged ${c.path}`,
        evidence: c.evidence ?? fakeEvidence(),
      })),
  };
}

describe("RiskAssessor", () => {
  it("ranks higher weighted contributions first", async () => {
    const assessor = new RiskAssessor([
      fakeSignal("s1", "churn", 1, [
        { path: "src/a.ts", weight: 90 },
        { path: "src/b.ts", weight: 20 },
      ]),
    ]);
    const result = await assessor.assess(input);
    expect(result.items[0]?.path).toBe("src/a.ts");
    expect(result.items[0]?.score).toBe(90);
    expect(result.items[1]?.path).toBe("src/b.ts");
  });

  it("normalizes only over signals that contributed to a path", async () => {
    // Path a gets two signals (90 and 30), path b gets only one (80).
    // a's score is the coefficient-weighted average of its two = 60;
    // b keeps its single signal's 80. b should therefore outrank a.
    const assessor = new RiskAssessor([
      fakeSignal("s1", "churn", 1, [
        { path: "src/a.ts", weight: 90 },
        { path: "src/b.ts", weight: 80 },
      ]),
      fakeSignal("s2", "policy", 1, [{ path: "src/a.ts", weight: 30 }]),
    ]);
    const result = await assessor.assess(input);
    const a = result.items.find((i) => i.path === "src/a.ts");
    const b = result.items.find((i) => i.path === "src/b.ts");
    expect(a?.score).toBe(60);
    expect(b?.score).toBe(80);
    expect(result.items[0]?.path).toBe("src/b.ts");
  });

  it("applies coefficients when folding", async () => {
    // incident coefficient 1.2 should dominate churn coefficient 0.7.
    const assessor = new RiskAssessor([
      fakeSignal("churn", "churn", 0.7, [{ path: "src/a.ts", weight: 50 }]),
      fakeSignal("incident", "incident", 1.2, [{ path: "src/a.ts", weight: 90 }]),
    ]);
    const result = await assessor.assess(input);
    const a = result.items[0];
    // weighted = 50*0.7 + 90*1.2 = 35 + 108 = 143; coef sum = 1.9; 143/1.9 ≈ 75.26
    expect(a?.score).toBeCloseTo(75.26, 1);
    // dominant category is incident (higher weight×coef).
    expect(a?.category).toBe("incident");
  });

  it("drops contributions with no evidence", async () => {
    const assessor = new RiskAssessor([
      fakeSignal("s1", "policy", 1, [{ path: "src/a.ts", weight: 99, evidence: [] }]),
    ]);
    const result = await assessor.assess(input);
    expect(result.items).toHaveLength(0);
  });

  it("skips disabled signals", async () => {
    const assessor = new RiskAssessor([
      fakeSignal("off", "churn", 1, [{ path: "src/a.ts", weight: 99 }], false),
    ]);
    const result = await assessor.assess(input);
    expect(result.items).toHaveLength(0);
    expect(result.stats.signalsRun).toBe(0);
  });

  it("merges evidence and records contributing signals", async () => {
    const assessor = new RiskAssessor([
      fakeSignal("s1", "churn", 1, [
        {
          path: "src/a.ts",
          weight: 50,
          evidence: [{ kind: "git_commit", sha: "abc", message: "m", ts: "t" }],
        },
      ]),
      fakeSignal("s2", "policy", 1, [
        {
          path: "src/a.ts",
          weight: 40,
          evidence: [{ kind: "policy_rule", ruleId: "r2", pattern: "src/**" }],
        },
      ]),
    ]);
    const result = await assessor.assess(input);
    const a = result.items[0];
    expect(a?.contributingSignals).toEqual(["s1", "s2"]);
    expect(a?.evidence).toHaveLength(2);
  });

  it("breaks ties deterministically by signal count then path", async () => {
    // Two paths with the same score; the one with more contributing signals wins.
    const assessor = new RiskAssessor([
      fakeSignal("s1", "churn", 1, [
        { path: "src/z.ts", weight: 50 },
        { path: "src/a.ts", weight: 50 },
      ]),
      fakeSignal("s2", "policy", 1, [{ path: "src/a.ts", weight: 50 }]),
    ]);
    const result = await assessor.assess(input);
    // src/a.ts has 2 signals (avg still 50), src/z.ts has 1 → a first.
    expect(result.items[0]?.path).toBe("src/a.ts");
  });

  it("is deterministic across repeated runs", async () => {
    const build = () =>
      new RiskAssessor([
        fakeSignal("s1", "churn", 0.7, [
          { path: "src/a.ts", weight: 70 },
          { path: "src/b.ts", weight: 40 },
        ]),
        fakeSignal("s2", "incident", 1.2, [{ path: "src/b.ts", weight: 90 }]),
      ]);
    const first = await build().assess(input);
    const second = await build().assess(input);
    expect(first).toEqual(second);
  });

  it("reports per-signal stats", async () => {
    const assessor = new RiskAssessor([
      fakeSignal("s1", "churn", 1, [
        { path: "src/a.ts", weight: 50 },
        { path: "src/b.ts", weight: 30 },
      ]),
    ]);
    const result = await assessor.assess(input);
    const stat = result.stats.perSignal.find((s) => s.id === "s1");
    expect(stat?.contributions).toBe(2);
    expect(stat?.totalWeight).toBe(80);
  });

  it("honors minScore", async () => {
    const assessor = new RiskAssessor(
      [
        fakeSignal("s1", "churn", 1, [
          { path: "src/a.ts", weight: 90 },
          { path: "src/b.ts", weight: 10 },
        ]),
      ],
      { minScore: 50 },
    );
    const result = await assessor.assess(input);
    expect(result.items.map((i) => i.path)).toEqual(["src/a.ts"]);
  });
});
