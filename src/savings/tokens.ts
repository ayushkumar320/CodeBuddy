import { countTokens } from "../planner/budget.js";

/**
 * The one place token counts are computed. Strings use the same deterministic
 * cl100k tokenizer as planner budgets; objects are measured by their JSON
 * serialization, which matches how they travel over MCP.
 */

export function estimateTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return 0;
  return countTokens(text);
}
