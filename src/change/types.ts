import type { PlanStatus } from "../core/plan-file-store.js";
import type { RiskItem } from "../risk/types.js";
import type { Suggestion } from "../suggest/types.js";

export type ChangeStatus = "no_changes" | "ready" | "review" | "blocked";

export type ChangePlanSummary = {
  id: string;
  title: string;
  status: PlanStatus;
  plannedPaths: string[];
  unexpectedPaths: string[];
  plannedTests: string[];
  missingPlannedTests: string[];
};

export type ChangeVerification = {
  changedCodeFiles: string[];
  changedTestFiles: string[];
  uncoveredCodeFiles: string[];
  plannedTests: string[];
  missingPlannedTests: string[];
  readyToVerify: boolean;
};

export type ChangeArchitecture = {
  dependentsByPath: Record<string, number>;
  totalDependents: number;
  /** Where the edges came from: an explicit Graphify graph or the import scan. */
  source: "graphify" | "imports";
  /** Why Graphify was not used, when one was requested but could not be read. */
  warning?: string;
};

export type ChangeReport = {
  status: ChangeStatus;
  paths: string[];
  plan: ChangePlanSummary | null;
  risk: {
    highestScore: number;
    items: RiskItem[];
  };
  architecture: ChangeArchitecture;
  suggestions: Suggestion[];
  verification: ChangeVerification;
};

export type TestCommandSource = "explicit" | "package_script" | "package_manager";

export type ChangeTestResult = {
  status: "passed" | "failed" | "timed_out" | "not_run";
  command: string | null;
  source: TestCommandSource | null;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  output: string;
};

export type ChangeVerificationResult = {
  report: ChangeReport;
  test: ChangeTestResult;
};
