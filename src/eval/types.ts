import type { ChangeStatus } from "../change/types.js";

export type EvaluationCase = {
  id: string;
  description: string;
  fixture: string;
  paths: string[];
  expectedStatus: ChangeStatus;
  minimumRisk?: number;
  requiredCategories?: string[];
};

export type EvaluationDataset = {
  version: 1;
  cases: EvaluationCase[];
};

export type EvaluationCaseResult = {
  id: string;
  description: string;
  passed: boolean;
  expectedStatus: ChangeStatus;
  actualStatus: ChangeStatus;
  highestRisk: number;
  categories: string[];
  failures: string[];
};

export type EvaluationResult = {
  datasetPath: string;
  passed: boolean;
  cases: EvaluationCaseResult[];
  summary: { total: number; passed: number; failed: number };
};
