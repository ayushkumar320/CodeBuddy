export type EmbeddingRequest = {
  model: string;
  input: string | string[];
};

export type EmbeddingResponse = {
  model: string;
  dimensions: number;
  vectors: number[][];
};

export type TextGenerationRequest = {
  model: string;
  prompt: string;
};

export type TextGenerationResponse = {
  model: string;
  text: string;
};

export type ModelProvider = {
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  generateText(request: TextGenerationRequest): Promise<TextGenerationResponse>;
};
