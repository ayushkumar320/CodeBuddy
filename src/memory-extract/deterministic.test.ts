import { describe, expect, it } from "vitest";
import { deterministicExtract, splitSentences } from "./deterministic.js";

function classesOf(summary: string, changedFiles?: string[]) {
  return deterministicExtract({
    summary,
    namespace: "proj",
    ...(changedFiles ? { changedFiles } : {}),
  });
}

describe("splitSentences", () => {
  it("splits on terminators and newlines and drops fragments and bullets", () => {
    expect(splitSentences("First one. Second two!\n- Third three")).toEqual([
      "First one.",
      "Second two!",
      "Third three",
    ]);
  });
});

describe("deterministicExtract", () => {
  it("classifies a decision with high confidence", () => {
    const [candidate] = classesOf("We decided to switch to Postgres for durability.");
    expect(candidate?.class).toBe("decision");
    expect(candidate?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("classifies an incident and boosts confidence when a root cause is stated", () => {
    const [candidate] = classesOf("The login crashed; root cause was a missing guard.");
    expect(candidate?.class).toBe("incident");
    expect(candidate?.confidence).toBeGreaterThan(0.8);
    expect(candidate?.severity).not.toBeNull();
  });

  it("treats a TODO as a note even when it mentions a bug", () => {
    const [candidate] = classesOf("TODO: fix the regression later.");
    expect(candidate?.class).toBe("note");
  });

  it("classifies a plain statement as a low-confidence fact", () => {
    const [candidate] = classesOf("The parser uses regex to extract imports.");
    expect(candidate?.class).toBe("fact");
    expect(candidate?.confidence).toBeLessThan(0.7);
  });

  it("classifies filler as ignored chatter", () => {
    const [candidate] = classesOf("Thanks for the help today.");
    expect(candidate?.class).toBe("ignored");
  });

  it("attaches changed files to incidents and decisions only", () => {
    const candidates = classesOf("The auth flow crashed on callback. The parser uses regex.", [
      "src/auth/oauth.ts",
    ]);
    const incident = candidates.find((c) => c.class === "incident");
    const fact = candidates.find((c) => c.class === "fact");
    expect(incident?.paths).toEqual(["src/auth/oauth.ts"]);
    expect(fact?.paths).toEqual([]);
  });
});
