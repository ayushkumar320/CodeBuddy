import type { ModelProvider } from "../providers/adapter.js";
import { generateEntityId } from "./ids.js";
import type { EmbeddingJob, MemoryRepository, ModelCallEntry } from "./repository.js";

export type EmbeddingWorkerOptions = {
  repository: MemoryRepository;
  provider: ModelProvider;
  pollIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  onDiagnostic?: ModelCallSink;
};

export type ModelCallSink = (entry: ModelCallEntry) => void | Promise<void>;

export type WorkerState = "idle" | "running" | "draining" | "stopped";

const DEFAULT_POLL_MS = 250;
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_MAX_ATTEMPTS = 5;

export class EmbeddingWorker {
  private readonly repo: MemoryRepository;
  private readonly provider: ModelProvider;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly onDiagnostic: ModelCallSink | undefined;

  private state: WorkerState = "idle";
  private loopPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private idleResolvers: Array<() => void> = [];
  private inFlight = 0;

  constructor(options: EmbeddingWorkerOptions) {
    this.repo = options.repository;
    this.provider = options.provider;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.onDiagnostic = options.onDiagnostic;
  }

  getState(): WorkerState {
    return this.state;
  }

  start(): void {
    if (this.state === "running") return;
    if (this.state === "draining" || this.state === "stopped") {
      this.state = "running";
    } else {
      this.state = "running";
    }
    this.loopPromise = this.loop();
  }

  notify(): void {
    if (this.wake) {
      const fn = this.wake;
      this.wake = null;
      fn();
    }
  }

  async drain(): Promise<void> {
    if (this.state === "idle" || this.state === "stopped") return;
    await new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
      this.notify();
    });
  }

  async stop(): Promise<void> {
    if (this.state === "stopped" || this.state === "idle") {
      this.state = "stopped";
      return;
    }
    this.state = "draining";
    this.notify();
    if (this.loopPromise) {
      await this.loopPromise;
    }
    this.state = "stopped";
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }

  private async loop(): Promise<void> {
    while (this.state === "running" || this.state === "draining") {
      const jobs = await this.repo.claimPendingEmbeddings(this.batchSize);
      if (jobs.length === 0) {
        this.flushIdleResolvers();
        if (this.state === "draining") {
          break;
        }
        await this.sleep();
        continue;
      }

      this.inFlight += jobs.length;
      try {
        await Promise.all(jobs.map((job) => this.processJob(job)));
      } finally {
        this.inFlight -= jobs.length;
      }
    }
    this.flushIdleResolvers();
  }

  private flushIdleResolvers(): void {
    if (this.inFlight > 0) return;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  private async processJob(job: EmbeddingJob): Promise<void> {
    try {
      const response = await this.provider.embed({
        input: job.content,
        model: job.embeddingModel,
      });
      const vector = response.vectors[0];
      if (!vector || vector.length === 0) {
        throw new Error("Provider returned no embedding vector.");
      }
      await this.repo.markEmbeddingReady(job.id, vector, response.model);
      await this.emitDiagnostic({
        id: generateEntityId("mc"),
        namespaceId: job.namespaceId,
        metadata: {
          model: response.model,
          type: "embedding",
          status: "success",
          latencyMs: 0,
          retries: 0,
          fallbackTriggered: false,
          coldStartWaitMs: 0,
        },
      });
    } catch (error) {
      const attempts = job.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      await this.repo.markEmbeddingFailed(job.id, message, attempts);
      await this.emitDiagnostic({
        id: generateEntityId("mc"),
        namespaceId: job.namespaceId,
        metadata: {
          model: job.embeddingModel,
          type: "embedding",
          status: attempts >= this.maxAttempts ? "failed" : "failed",
          latencyMs: 0,
          error: message,
          retries: attempts,
          fallbackTriggered: false,
          coldStartWaitMs: 0,
        },
      });
    }
  }

  private async emitDiagnostic(entry: ModelCallEntry): Promise<void> {
    try {
      await this.repo.recordModelCall(entry);
    } catch {
      /* model_calls failure must not crash the worker */
    }
    if (this.onDiagnostic) {
      await this.onDiagnostic(entry);
    }
  }

  private sleep(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, this.pollIntervalMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
