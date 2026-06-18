import type { ContextPolicy, PlanInput, PlannedContext } from "./types.js";

export class DefaultPolicy implements ContextPolicy {
  async plan(_input: PlanInput): Promise<PlannedContext> {
    throw new Error("DefaultPolicy is implemented in Phase 5.");
  }
}
