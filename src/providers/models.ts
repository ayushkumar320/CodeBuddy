export type ModelRole = "primary" | "fallback" | "last_resort";
export type ModelKind = "embedding" | "llm";

export type ModelDefinition = {
  id: string;
  role: ModelRole;
  kind: ModelKind;
  dimensions?: number;
  contextWindow?: number;
  dailyCallBudget?: number;
  supportsBatch?: boolean;
};

export const EMBEDDING_DIMENSIONS = 384;

export const DEFAULT_EMBEDDING_MODELS = [
  {
    id: "sentence-transformers/all-MiniLM-L6-v2",
    role: "primary",
    kind: "embedding",
    dimensions: EMBEDDING_DIMENSIONS,
    dailyCallBudget: 1_000,
    supportsBatch: true,
  },
  {
    id: "BAAI/bge-small-en-v1.5",
    role: "fallback",
    kind: "embedding",
    dimensions: EMBEDDING_DIMENSIONS,
    dailyCallBudget: 1_000,
    supportsBatch: true,
  },
] satisfies ModelDefinition[];

export const DEFAULT_LLM_MODELS = [
  {
    id: "meta-llama/Llama-3.2-3B-Instruct",
    role: "primary",
    kind: "llm",
    contextWindow: 131_072,
    dailyCallBudget: 300,
  },
  {
    id: "Qwen/Qwen2.5-7B-Instruct",
    role: "fallback",
    kind: "llm",
    contextWindow: 32_768,
    dailyCallBudget: 300,
  },
  {
    id: "mistralai/Mistral-7B-Instruct-v0.3",
    role: "last_resort",
    kind: "llm",
    contextWindow: 32_768,
    dailyCallBudget: 300,
  },
] satisfies ModelDefinition[];

export const DEFAULT_GROQ_LLM_MODELS = [
  {
    id: "llama-3.3-70b-versatile",
    role: "primary",
    kind: "llm",
    contextWindow: 131_072,
    dailyCallBudget: 1_000,
  },
  {
    id: "llama-3.1-8b-instant",
    role: "fallback",
    kind: "llm",
    contextWindow: 131_072,
    dailyCallBudget: 1_000,
  },
  {
    id: "mixtral-8x7b-32768",
    role: "last_resort",
    kind: "llm",
    contextWindow: 32_768,
    dailyCallBudget: 1_000,
  },
] satisfies ModelDefinition[];

export const MODEL_REGISTRY = [
  ...DEFAULT_EMBEDDING_MODELS,
  ...DEFAULT_LLM_MODELS,
  ...DEFAULT_GROQ_LLM_MODELS,
];

export function getModelDefinition(modelId: string): ModelDefinition | undefined {
  return MODEL_REGISTRY.find((model) => model.id === modelId);
}

export function getModelContextWindow(modelId: string): number | undefined {
  return getModelDefinition(modelId)?.contextWindow;
}

export function assertCompatibleEmbeddingModels(models: ModelDefinition[]): void {
  const mismatchedModel = models.find((model) => model.dimensions !== EMBEDDING_DIMENSIONS);

  if (mismatchedModel) {
    throw new Error(
      `Embedding model ${mismatchedModel.id} has ${mismatchedModel.dimensions ?? "unknown"} dimensions; expected ${EMBEDDING_DIMENSIONS}.`,
    );
  }
}
