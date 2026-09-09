import { describe, expect, it } from "vitest";
import { runEvaluation } from "./runner.js";

describe("runEvaluation", () => {
  it("passes the committed readiness dataset", async () => {
    const result = await runEvaluation();
    expect(result.passed).toBe(true);
    expect(result.summary.total).toBeGreaterThanOrEqual(3);
  });
});
