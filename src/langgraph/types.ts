import type { PlannedContext } from "../planner/types.js";

export type CodeBuddyState = {
  messages: unknown[];
  memory?: PlannedContext;
  sessionId: string;
  agentId?: string;
};
