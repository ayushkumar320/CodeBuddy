export type ProviderCallType = "embedding" | "llm";

export type ProviderCallStatus =
  | "success"
  | "failed"
  | "timeout"
  | "rate_limited"
  | "gated"
  | "fallback";

export type ProviderCallMetadata = {
  model: string;
  type: ProviderCallType;
  status: ProviderCallStatus;
  latencyMs: number;
  tokens?: number;
  error?: string;
  retries: number;
  fallbackTriggered: boolean;
  coldStartWaitMs: number;
};

export type ProviderDiagnosticsHook = (metadata: ProviderCallMetadata) => void | Promise<void>;

export type EmbeddingRequest = {
  input: string | string[];
  model?: string;
};

export type EmbeddingResponse = {
  model: string;
  dimensions: number;
  vectors: number[][];
};

export type TextGenerationRequest = {
  prompt: string;
  model?: string;
};

export type TextGenerationResponse = {
  model: string;
  text: string;
};

export type ModelProvider = {
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  generateText(request: TextGenerationRequest): Promise<TextGenerationResponse>;
};
