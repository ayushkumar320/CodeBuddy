import type {
  EmbeddingRequest,
  EmbeddingResponse,
  ModelProvider,
  TextGenerationRequest,
  TextGenerationResponse,
} from "./adapter.js";

export class HuggingFaceProvider implements ModelProvider {
  async embed(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error("HuggingFaceProvider.embed is implemented in Phase 3.");
  }

  async generateText(_request: TextGenerationRequest): Promise<TextGenerationResponse> {
    throw new Error("HuggingFaceProvider.generateText is implemented in Phase 3.");
  }
}
