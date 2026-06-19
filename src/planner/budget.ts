import { Tiktoken } from "js-tiktoken/lite";
import cl100kBase from "js-tiktoken/ranks/cl100k_base";
import { getModelContextWindow } from "../providers/models.js";

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!encoder) {
    encoder = new Tiktoken(cl100kBase);
  }
  return encoder;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return getEncoder().encode(text).length;
  } catch {
    return Math.max(1, Math.ceil(text.length / 4));
  }
}

export type BudgetClampResult = {
  budget: number;
  clamped: boolean;
  reason?: string;
};

export function clampBudgetForCallerModel(
  requestedBudget: number,
  callerModel: string | undefined,
): BudgetClampResult {
  if (!callerModel) {
    return { budget: requestedBudget, clamped: false };
  }
  const ctx = getModelContextWindow(callerModel);
  if (!ctx) {
    return { budget: requestedBudget, clamped: false };
  }
  const headroom = Math.floor(ctx * 0.75);
  if (requestedBudget > headroom) {
    return {
      budget: headroom,
      clamped: true,
      reason: `budget ${requestedBudget} exceeds 75% of ${callerModel} context window (${ctx}); clamped to ${headroom}.`,
    };
  }
  return { budget: requestedBudget, clamped: false };
}
