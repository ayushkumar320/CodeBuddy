import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { buildChangeReport } from "../change/engine.js";
import type { EvaluationDataset, EvaluationResult } from "./types.js";

export type RunEvaluationInput = { datasetPath?: string; repositoryRoot?: string };

export async function runEvaluation(input: RunEvaluationInput = {}): Promise<EvaluationResult> {
  const datasetPath = resolve(
    input.datasetPath ?? join(process.cwd(), "evals", "change-readiness.json"),
  );
  const dataset = JSON.parse(await readFile(datasetPath, "utf8")) as EvaluationDataset;
  if (dataset.version !== 1 || !Array.isArray(dataset.cases)) {
    throw new Error(`Unsupported evaluation dataset: ${datasetPath}`);
  }

  const datasetDirectory = dirname(datasetPath);
  const results = await Promise.all(
    dataset.cases.map(async (evaluationCase) => {
      const fixtureRoot = isAbsolute(evaluationCase.fixture)
        ? evaluationCase.fixture
        : resolve(input.repositoryRoot ?? datasetDirectory, evaluationCase.fixture);
      const report = await buildChangeReport({
        repositoryRoot: fixtureRoot,
        namespace: `eval:${evaluationCase.id}`,
        paths: evaluationCase.paths,
        useGit: false,
      });
      const failures: string[] = [];
      if (report.status !== evaluationCase.expectedStatus) {
        failures.push(`status expected ${evaluationCase.expectedStatus}, got ${report.status}`);
      }
      if (
        evaluationCase.minimumRisk !== undefined &&
        report.risk.highestScore < evaluationCase.minimumRisk
      ) {
        failures.push(
          `risk expected >= ${evaluationCase.minimumRisk}, got ${report.risk.highestScore}`,
        );
      }
      const categories: string[] = [
        ...new Set(report.suggestions.map((suggestion) => suggestion.category)),
      ];
      for (const category of evaluationCase.requiredCategories ?? []) {
        if (!categories.includes(category)) failures.push(`missing category ${category}`);
      }
      return {
        id: evaluationCase.id,
        description: evaluationCase.description,
        passed: failures.length === 0,
        expectedStatus: evaluationCase.expectedStatus,
        actualStatus: report.status,
        highestRisk: report.risk.highestScore,
        categories,
        failures,
      };
    }),
  );
  const passed = results.filter((result) => result.passed).length;
  return {
    datasetPath,
    passed: passed === results.length,
    cases: results,
    summary: { total: results.length, passed, failed: results.length - passed },
  };
}
