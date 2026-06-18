import { HfInference } from "@huggingface/inference";
import type {
  EmbeddingRequest,
  EmbeddingResponse,
  ModelProvider,
  ProviderDiagnosticsHook,
  TextGenerationRequest,
  TextGenerationResponse,
} from "./adapter.js";
import {
  assertCompatibleEmbeddingModels,
  DEFAULT_EMBEDDING_MODELS,
  DEFAULT_LLM_MODELS,
  EMBEDDING_DIMENSIONS,
  type ModelDefinition,
} from "./models.js";
import {
  DEFAULT_RESILIENCE_OPTIONS,
  HuggingFaceResilience,
  type ResilienceOptions,
} from "./resilience.js";

export type HuggingFaceProviderOptions = {
  apiKey?: string;
  client?: Pick<HfInference, "featureExtraction" | "textGeneration">;
  embeddingModels?: ModelDefinition[];
  llmModels?: ModelDefinition[];
  resilience?: Partial<ResilienceOptions>;
  onDiagnostic?: ProviderDiagnosticsHook;
};

export class HuggingFaceProvider implements ModelProvider {
  private readonly client: Pick<HfInference, "featureExtraction" | "textGeneration">;
  private readonly embeddingModels: ModelDefinition[];
  private readonly llmModels: ModelDefinition[];
  private readonly resilience: HuggingFaceResilience;
  private readonly onDiagnostic: ProviderDiagnosticsHook | undefined;

  constructor(options: HuggingFaceProviderOptions = {}) {
    this.client = options.client ?? new HfInference(options.apiKey);
    this.embeddingModels = options.embeddingModels ?? DEFAULT_EMBEDDING_MODELS;
    this.llmModels = options.llmModels ?? DEFAULT_LLM_MODELS;
    this.resilience = new HuggingFaceResilience({
      ...DEFAULT_RESILIENCE_OPTIONS,
      ...options.resilience,
    });
    this.onDiagnostic = options.onDiagnostic;

    assertCompatibleEmbeddingModels(this.embeddingModels);
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const primaryModel = request.model ?? this.embeddingModels[0]?.id;
    if (!primaryModel) {
      throw new Error("No embedding model configured.");
    }

    const fallbackModels = this.embeddingModels
      .map((model) => model.id)
      .filter((model) => model !== primaryModel);

    return this.resilience.execute({
      model: primaryModel,
      fallbackModels,
      type: "embedding",
      ...(this.onDiagnostic ? { onDiagnostic: this.onDiagnostic } : {}),
      call: async (model) => {
        const response = await this.client.featureExtraction({
          model,
          inputs: request.input,
        });

        return {
          model,
          dimensions: EMBEDDING_DIMENSIONS,
          vectors: normalizeEmbeddingResponse(response),
        };
      },
    });
  }

  async generateText(request: TextGenerationRequest): Promise<TextGenerationResponse> {
    const primaryModel = request.model ?? this.llmModels[0]?.id;
    if (!primaryModel) {
      throw new Error("No LLM model configured.");
    }

    const fallbackModels = this.llmModels
      .map((model) => model.id)
      .filter((model) => model !== primaryModel);

    return this.resilience.execute({
      model: primaryModel,
      fallbackModels,
      type: "llm",
      ...(this.onDiagnostic ? { onDiagnostic: this.onDiagnostic } : {}),
      call: async (model) => {
        const response = await this.client.textGeneration({
          model,
          inputs: request.prompt,
        });

        return {
          model,
          text: response.generated_text,
        };
      },
    });
  }
}

function normalizeEmbeddingResponse(response: unknown): number[][] {
  if (!Array.isArray(response)) {
    throw new Error("Unexpected Hugging Face embedding response.");
  }

  if (response.every((value) => typeof value === "number")) {
    return [response as number[]];
  }

  if (
    response.every(
      (vector) => Array.isArray(vector) && vector.every((value) => typeof value === "number"),
    )
  ) {
    return response as number[][];
  }

  throw new Error("Unexpected Hugging Face embedding vector shape.");
}
