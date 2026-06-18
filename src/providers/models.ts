export type ModelRole = "primary" | "fallback" | "last_resort";

export type ModelDefinition = {
  id: string;
  role: ModelRole;
  kind: "embedding" | "llm";
  dimensions?: number;
};

export const DEFAULT_EMBEDDING_MODELS: ModelDefinition[] = [
  {
    id: "sentence-transformers/all-MiniLM-L6-v2",
    role: "primary",
    kind: "embedding",
    dimensions: 384,
  },
  {
    id: "BAAI/bge-small-en-v1.5",
    role: "fallback",
    kind: "embedding",
    dimensions: 384,
  },
];

export const DEFAULT_LLM_MODELS: ModelDefinition[] = [
  {
    id: "meta-llama/Llama-3.2-3B-Instruct",
    role: "primary",
    kind: "llm",
  },
  {
    id: "Qwen/Qwen2.5-7B-Instruct",
    role: "fallback",
    kind: "llm",
  },
  {
    id: "mistralai/Mistral-7B-Instruct-v0.3",
    role: "last_resort",
    kind: "llm",
  },
];
