import PQueue from "p-queue";
import pRetry, { AbortError } from "p-retry";
import pTimeout from "p-timeout";
import type { ProviderCallMetadata, ProviderCallType } from "./adapter.js";

export type ResilienceOptions = {
  retries: number;
  concurrency: number;
  rateLimitPerMinute: number;
  timeoutMs: number;
  warmCacheTtlMs: number;
  coldStartBufferMs: number;
  jitterMs: number;
  minRetryTimeoutMs: number;
  maxRetryTimeoutMs: number;
};

export type ResilientCallInput<T> = {
  model: string;
  type: ProviderCallType;
  fallbackModels?: string[];
  call: (model: string) => Promise<T>;
  onDiagnostic?: ((metadata: ProviderCallMetadata) => void | Promise<void>) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
};

export type HuggingFaceErrorLike = Error & {
  status?: number;
  statusCode?: number;
  response?: {
    status?: number;
    headers?: {
      get?: (name: string) => string | null;
    };
  };
  estimated_time?: number;
  estimatedTime?: number;
  cause?: unknown;
};

export const DEFAULT_RESILIENCE_OPTIONS: ResilienceOptions = {
  retries: 5,
  concurrency: 2,
  rateLimitPerMinute: 10,
  timeoutMs: 90_000,
  warmCacheTtlMs: 5 * 60_000,
  coldStartBufferMs: 2_000,
  jitterMs: 250,
  minRetryTimeoutMs: 1_000,
  maxRetryTimeoutMs: 30_000,
};

export class GatedModelError extends Error {
  readonly model: string;

  constructor(model: string) {
    super(
      `Model ${model} is gated. Accept the license at https://huggingface.co/${model} and retry.`,
    );
    this.name = "GatedModelError";
    this.model = model;
  }
}

export class ModelUnavailableError extends Error {
  readonly model: string;

  constructor(model: string, cause?: unknown) {
    super(`Model ${model} is unavailable.`);
    this.name = "ModelUnavailableError";
    this.model = model;
    this.cause = cause;
  }
}

export class HuggingFaceResilience {
  private readonly options: ResilienceOptions;
  private readonly queues = new Map<string, PQueue>();
  private readonly warmUntil = new Map<string, number>();

  constructor(options: Partial<ResilienceOptions> = {}) {
    this.options = {
      ...DEFAULT_RESILIENCE_OPTIONS,
      ...options,
    };
  }

  isWarm(model: string, now = Date.now()): boolean {
    return (this.warmUntil.get(model) ?? 0) > now;
  }

  markWarm(model: string, now = Date.now()): void {
    this.warmUntil.set(model, now + this.options.warmCacheTtlMs);
  }

  async execute<T>(input: ResilientCallInput<T>): Promise<T> {
    const models = [input.model, ...(input.fallbackModels ?? [])];
    let lastError: unknown;

    for (const [index, model] of models.entries()) {
      const fallbackTriggered = index > 0;

      try {
        return await this.executeForModel(model, input, fallbackTriggered);
      } catch (error) {
        lastError = error;

        if (error instanceof GatedModelError) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("All provider models failed.");
  }

  private async executeForModel<T>(
    model: string,
    input: ResilientCallInput<T>,
    fallbackTriggered: boolean,
  ): Promise<T> {
    const queue = this.getQueue(model);
    const startedAt = Date.now();
    let retries = 0;
    let coldStartWaitMs = 0;
    let status: ProviderCallMetadata["status"] = fallbackTriggered ? "fallback" : "success";

    try {
      const result = await queue.add(
        async () =>
          pRetry(
            async () => {
              try {
                return await pTimeout(input.call(model), {
                  milliseconds: this.options.timeoutMs,
                });
              } catch (error) {
                const classified = classifyHuggingFaceError(error, model);

                if (classified.kind === "gated") {
                  status = "gated";
                  throw new AbortError(new GatedModelError(model));
                }

                if (classified.kind === "cold_start") {
                  const waitMs = this.calculateColdStartWaitMs(classified.estimatedTimeSeconds);
                  coldStartWaitMs += waitMs;
                  await (input.sleep ?? sleep)(waitMs);
                  throw error;
                }

                if (classified.kind === "rate_limited") {
                  status = "rate_limited";
                  if (classified.retryAfterMs) {
                    await (input.sleep ?? sleep)(classified.retryAfterMs);
                  }
                  throw error;
                }

                if (classified.kind === "unavailable") {
                  throw new ModelUnavailableError(model, error);
                }

                if (classified.kind === "timeout") {
                  status = "timeout";
                }

                throw error;
              }
            },
            {
              retries: this.options.retries,
              minTimeout: this.options.minRetryTimeoutMs,
              maxTimeout: this.options.maxRetryTimeoutMs,
              factor: 2,
              randomize: true,
              onFailedAttempt: (error) => {
                retries = error.attemptNumber;
              },
            },
          ),
        { throwOnTimeout: true },
      );

      this.markWarm(model);
      status = fallbackTriggered ? "fallback" : "success";
      await input.onDiagnostic?.({
        model,
        type: input.type,
        status,
        latencyMs: Date.now() - startedAt,
        retries,
        fallbackTriggered,
        coldStartWaitMs,
      });
      return result;
    } catch (error) {
      const finalError =
        error instanceof AbortError && error.originalError ? error.originalError : error;
      const classified = classifyHuggingFaceError(finalError, model);
      const finalStatus = statusForClassifiedError(classified.kind, status);

      await input.onDiagnostic?.({
        model,
        type: input.type,
        status: finalStatus,
        latencyMs: Date.now() - startedAt,
        error: finalError instanceof Error ? finalError.message : String(finalError),
        retries,
        fallbackTriggered,
        coldStartWaitMs,
      });

      throw finalError;
    }
  }

  private getQueue(model: string): PQueue {
    const existing = this.queues.get(model);
    if (existing) {
      return existing;
    }

    const queue = new PQueue({
      concurrency: this.options.concurrency,
      intervalCap: this.options.rateLimitPerMinute,
      interval: 60_000,
    });

    this.queues.set(model, queue);
    return queue;
  }

  private calculateColdStartWaitMs(estimatedTimeSeconds: number): number {
    return Math.ceil(
      estimatedTimeSeconds * 1_000 + this.options.coldStartBufferMs + this.randomJitter(),
    );
  }

  private randomJitter(): number {
    return Math.floor(Math.random() * this.options.jitterMs);
  }
}

type ClassifiedError =
  | { kind: "cold_start"; estimatedTimeSeconds: number }
  | { kind: "rate_limited"; retryAfterMs?: number }
  | { kind: "gated" }
  | { kind: "unavailable" }
  | { kind: "timeout" }
  | { kind: "unknown" };

export function classifyHuggingFaceError(error: unknown, model: string): ClassifiedError {
  if (error instanceof GatedModelError) {
    return { kind: "gated" };
  }

  if (error instanceof ModelUnavailableError) {
    return { kind: "unavailable" };
  }

  if (error instanceof Error && error.name === "TimeoutError") {
    return { kind: "timeout" };
  }

  const hfError = error as HuggingFaceErrorLike;
  const status = hfError.status ?? hfError.statusCode ?? hfError.response?.status;

  if (status === 403) {
    return { kind: "gated" };
  }

  if (status === 404) {
    return { kind: "unavailable" };
  }

  if (status === 429) {
    const retryAfterMs = readRetryAfterMs(hfError);
    return retryAfterMs === undefined
      ? { kind: "rate_limited" }
      : { kind: "rate_limited", retryAfterMs };
  }

  if (status === 503) {
    const estimatedTimeSeconds = readEstimatedTimeSeconds(hfError);
    if (estimatedTimeSeconds !== undefined) {
      return { kind: "cold_start", estimatedTimeSeconds };
    }
  }

  if (error instanceof Error && error.message.includes("timed out")) {
    return { kind: "timeout" };
  }

  if (error instanceof Error && error.message.includes(model) && error.message.includes("gated")) {
    return { kind: "gated" };
  }

  return { kind: "unknown" };
}

function statusForClassifiedError(
  kind: ClassifiedError["kind"],
  currentStatus: ProviderCallMetadata["status"],
): ProviderCallMetadata["status"] {
  if (kind === "gated") {
    return "gated";
  }
  if (kind === "rate_limited") {
    return "rate_limited";
  }
  if (kind === "timeout") {
    return "timeout";
  }
  if (currentStatus === "fallback") {
    return "fallback";
  }
  return "failed";
}

function readEstimatedTimeSeconds(error: HuggingFaceErrorLike): number | undefined {
  if (typeof error.estimated_time === "number") {
    return error.estimated_time;
  }
  if (typeof error.estimatedTime === "number") {
    return error.estimatedTime;
  }
  if (typeof error.cause === "object" && error.cause !== null && "estimated_time" in error.cause) {
    const estimatedTime = (error.cause as { estimated_time?: unknown }).estimated_time;
    return typeof estimatedTime === "number" ? estimatedTime : undefined;
  }
  return undefined;
}

function readRetryAfterMs(error: HuggingFaceErrorLike): number | undefined {
  const retryAfter = error.response?.headers?.get?.("retry-after");
  if (!retryAfter) {
    return undefined;
  }

  const retryAfterSeconds = Number(retryAfter);
  return Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
