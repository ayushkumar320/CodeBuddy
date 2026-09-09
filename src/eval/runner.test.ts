import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runEvaluation } from "./runner.js";

describe("runEvaluation", () => {
  it("passes the committed readiness dataset", async () => {
    const datasetPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../evals/change-readiness.json",
    );
    const result = await runEvaluation({ datasetPath });
    expect(result).toMatchObject({ passed: true });
    expect(result.summary.total).toBeGreaterThanOrEqual(3);
  });
});
