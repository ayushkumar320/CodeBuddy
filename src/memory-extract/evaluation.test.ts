import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deterministicExtract } from "./deterministic.js";
import type { MemoryClass } from "./types.js";

type EvaluationCase = { summary: string; expected: MemoryClass };

describe("deterministic extraction evaluation corpus", () => {
  it("meets the checked-in classification baseline", async () => {
    const path = fileURLToPath(new URL("./__fixtures__/evaluation.json", import.meta.url));
    const cases = JSON.parse(await readFile(path, "utf8")) as EvaluationCase[];
    const correct = cases.filter(({ summary, expected }) =>
      deterministicExtract({ summary, namespace: "evaluation" }).some(
        (candidate) => candidate.class === expected,
      ),
    ).length;
    const accuracy = correct / cases.length;
    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(accuracy).toBeGreaterThanOrEqual(0.875);
  });
});
