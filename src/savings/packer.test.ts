import { describe, expect, it } from "vitest";
import { packByBudget } from "./packer.js";
import { estimateTokens } from "./tokens.js";
import type { PackCandidate } from "./types.js";

const big = "x".repeat(400);
const small = "y".repeat(40);
const bigTokens = estimateTokens(big);
const smallTokens = estimateTokens(small);

describe("packByBudget", () => {
  it("includes everything when the budget is ample", () => {
    const candidates: PackCandidate<string>[] = [
      { value: "a", priority: 1, text: small },
      { value: "b", priority: 1, text: small },
    ];
    const result = packByBudget(candidates, 1000);
    expect(result.items.every((i) => i.status === "included")).toBe(true);
    expect(result.stats.skipped).toBe(0);
  });

  it("keeps the highest-priority evidence and skips low-priority under a tight budget", () => {
    const candidates: PackCandidate<string>[] = [
      { value: "low", priority: 1, text: big },
      { value: "critical", priority: 10, text: big },
    ];
    const result = packByBudget(candidates, bigTokens); // room for exactly one big item
    const byValue = new Map(result.items.map((i) => [i.value, i.status]));
    expect(byValue.get("critical")).toBe("included");
    expect(byValue.get("low")).toBe("skipped");
  });

  it("uses a compressed rendering when the full text does not fit", () => {
    const candidates: PackCandidate<string>[] = [
      { value: "a", priority: 5, text: big },
      { value: "b", priority: 1, text: big, compressedText: small },
    ];
    const result = packByBudget(candidates, bigTokens + smallTokens); // one big + one small fits
    const byValue = new Map(result.items.map((i) => [i.value, i.status]));
    expect(byValue.get("a")).toBe("included");
    expect(byValue.get("b")).toBe("compressed");
  });

  it("reports stable, coherent stats", () => {
    const candidates: PackCandidate<string>[] = [
      { value: "a", priority: 2, text: big },
      { value: "b", priority: 1, text: big },
    ];
    const result = packByBudget(candidates, bigTokens);
    expect(result.stats.candidateTokens).toBe(bigTokens * 2);
    expect(result.stats.returnedTokens).toBe(bigTokens);
    expect(result.stats.savedTokens).toBe(bigTokens);
    expect(result.stats.compressionRatio).toBeCloseTo(0.5);
  });

  it("preserves original order in the returned items", () => {
    const candidates: PackCandidate<string>[] = [
      { value: "a", priority: 1, text: small },
      { value: "b", priority: 9, text: small },
    ];
    const result = packByBudget(candidates, 1000);
    expect(result.items.map((i) => i.value)).toEqual(["a", "b"]);
  });
});
