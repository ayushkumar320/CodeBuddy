import pRetry, { AbortError } from "p-retry";
import pTimeout from "p-timeout";
import type {
  EmbeddingRequest,
  EmbeddingResponse,
  ModelProvider,
  ProviderCallMetadata,
  ProviderDiagnosticsHook,
  TextGenerationRequest,
  TextGenerationResponse,
} from "./adapter.js";
import { DEFAULT_GROQ_LLM_MODELS, type ModelDefinition } from "./models.js";

const DEFAULT_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export type GroqFetch = (
  input: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export type GroqProviderOptions = {
  apiKey?: string;
  endpoint?: string;
  llmModels?: ModelDefinition[];
  fetchImpl?: GroqFetch;
  timeoutMs?: number;
  retries?: number;
  onDiagnostic?: ProviderDiagnosticsHook;
};

const DEFAULTS = {
  timeoutMs: 60_000,
  retries: 3,
};

export class GroqAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroqAuthError";
  }
}

export class GroqRateLimitError extends Error {
  readonly retryAfterMs: number | undefined;
  constructor(retryAfterMs: number | undefined) {
    super("Groq rate limit hit (429).");
    this.name = "GroqRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class GroqModelUnavailableError extends Error {
  constructor(public readonly model: string) {
    super(`Groq model "${model}" is not available.`);
    this.name = "GroqModelUnavailableError";
  }
}

export class GroqProvider implements ModelProvider {
  private readonly apiKey: string | undefined;
  private readonly endpoint: string;
  private readonly llmModels: ModelDefinition[];
  private readonly fetchImpl: GroqFetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly onDiagnostic: ProviderDiagnosticsHook | undefined;

  constructor(options: GroqProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.GROQ_API_KEY;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.llmModels = options.llmModels ?? DEFAULT_GROQ_LLM_MODELS;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as GroqFetch);
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.retries = options.retries ?? DEFAULTS.retries;
    this.onDiagnostic = options.onDiagnostic;
  }

  async embed(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error(
      "GroqProvider does not support embeddings. Use HuggingFaceProvider for the embedding side, or set CodeBuddyConfig.provider.type to 'huggingface'.",
    );
  }

  async generateText(request: TextGenerationRequest): Promise<TextGenerationResponse> {
    if (!this.apiKey) {
      throw new GroqAuthError(
        "Groq API key missing. Set GROQ_API_KEY or pass provider.apiKey in CodeBuddyConfig.",
      );
    }
    const primary = request.model ?? this.llmModels[0]?.id;
    if (!primary) {
      throw new Error("No Groq LLM model configured.");
    }
    const chain = [primary, ...this.llmModels.map((m) => m.id).filter((id) => id !== primary)];

    let lastError: unknown;
    for (const [index, model] of chain.entries()) {
      const fallbackTriggered = index > 0;
      try {
        return await this.callWithRetry(model, request.prompt, fallbackTriggered);
      } catch (error) {
        lastError = error;
        if (error instanceof GroqAuthError) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("All Groq models failed.");
  }

  private async callWithRetry(
    model: string,
    prompt: string,
    fallbackTriggered: boolean,
  ): Promise<TextGenerationResponse> {
    const startedAt = Date.now();
    let retries = 0;
    let status: ProviderCallMetadata["status"] = fallbackTriggered ? "fallback" : "success";

    try {
      const result = await pRetry(
        async () => {
          try {
            return await pTimeout(this.callOnce(model, prompt), { milliseconds: this.timeoutMs });
          } catch (error) {
            if (error instanceof GroqAuthError) {
              throw new AbortError(error);
            }
            if (error instanceof GroqRateLimitError) {
              status = "rate_limited";
              if (error.retryAfterMs) await sleep(error.retryAfterMs);
              throw error;
            }
            if (error instanceof GroqModelUnavailableError) {
              throw new AbortError(error);
            }
            if (error instanceof Error && error.name === "TimeoutError") {
              status = "timeout";
            }
            throw error;
          }
        },
        {
          retries: this.retries,
          minTimeout: 500,
          maxTimeout: 8_000,
          factor: 2,
          randomize: true,
          onFailedAttempt: (attempt) => {
            retries = attempt.attemptNumber;
          },
        },
      );

      status = fallbackTriggered ? "fallback" : "success";
      await this.emit({
        model,
        type: "llm",
        status,
        latencyMs: Date.now() - startedAt,
        retries,
        fallbackTriggered,
        coldStartWaitMs: 0,
      });
      return { model, text: result };
    } catch (error) {
      const final =
        error instanceof AbortError && error.originalError ? error.originalError : error;
      await this.emit({
        model,
        type: "llm",
        status: status === "success" ? "failed" : status,
        latencyMs: Date.now() - startedAt,
        error: final instanceof Error ? final.message : String(final),
        retries,
        fallbackTriggered,
        coldStartWaitMs: 0,
      });
      throw final;
    }
  }

  private async callOnce(model: string, prompt: string): Promise<string> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (response.status === 401 || response.status === 403) {
      throw new GroqAuthError("Groq rejected the API key (401/403).");
    }
    if (response.status === 404) {
      throw new GroqModelUnavailableError(model);
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const ms = retryAfter ? Math.max(0, Number(retryAfter) * 1000) : undefined;
      throw new GroqRateLimitError(Number.isFinite(ms as number) ? ms : undefined);
    }
    if (!response.ok) {
      const body = await safeReadText(response);
      throw new Error(`Groq request failed (${response.status}): ${body}`);
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error("Groq response missing choices[0].message.content.");
    }
    return text;
  }

  private async emit(metadata: ProviderCallMetadata): Promise<void> {
    if (this.onDiagnostic) await this.onDiagnostic(metadata);
  }
}

async function safeReadText(response: { text(): Promise<string> }): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable>";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
