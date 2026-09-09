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
