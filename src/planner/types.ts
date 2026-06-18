export type PlanInput = {
  namespace: string;
  sessionId: string;
  query: string;
  budget: number;
};

export type PlannedMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type PlannerStats = {
  tokensUsed: number;
  itemsIncluded: number;
  itemsSkipped: number;
  budgetHeadroom: number;
};

export type PlannedContext = {
  system: string;
  messages: PlannedMessage[];
  stats: PlannerStats;
};

export type ContextPolicy = {
  plan(input: PlanInput): Promise<PlannedContext>;
};
