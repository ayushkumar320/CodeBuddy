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
/** After a failed poll, wait this long before retrying so a DB outage doesn't spin. */
const ERROR_BACKOFF_MS = 2_000;

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
    // Never run two loops at once: a start() during 'draining' must not
    // overwrite loopPromise while the old loop is still finishing.
    if (this.loopPromise !== null) return;
    this.state = "running";
    this.loopPromise = this.loop().finally(() => {
      this.loopPromise = null;
    });
    // A rejected loop must never become an unhandled rejection (Node 20 kills
    // the process); failures are contained per-iteration below.
    this.loopPromise.catch(() => {});
  }

  notify(): void {
    if (this.wake) {
      const fn = this.wake;
      this.wake = null;
      fn();
    }
  }

  /**
   * Resolve once the worker reaches an empty poll (no in-flight jobs and
   * nothing left to claim). Retained for API compatibility: with
   * repository-side leases and backoff there is no unbounded claim window to
   * wait out anymore.
   */
  async drain(): Promise<void> {
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

  getInFlight(): number {
    return this.inFlight;
  }

  private async loop(): Promise<void> {
    while (this.state === "running" || this.state === "draining") {
      let jobs: EmbeddingJob[];
      try {
        jobs = await this.repo.claimPendingEmbeddings(this.batchSize);
      } catch (error) {
        // A transient DB error must never escape the loop — an escaping
        // rejection used to crash the whole MCP server process.
        console.error(
          `[worker] claimPendingEmbeddings failed: ${error instanceof Error ? error.message : String(error)}; retrying`,
        );
        if (this.state === "running") await this.sleep(ERROR_BACKOFF_MS);
        continue;
      }
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
      await this.repo.markEmbeddingFailed(job.id, message, attempts, {
        maxAttempts: this.maxAttempts,
      });
      await this.emitDiagnostic({
        id: generateEntityId("mc"),
        namespaceId: job.namespaceId,
        metadata: {
          model: job.embeddingModel,
          type: "embedding",
          status: attempts >= this.maxAttempts ? "failed" : "fallback",
          latencyMs: 0,
          error: message,
          retries: attempts,
          fallbackTriggered: false,
          coldStartWaitMs: 0,
        },
      });
    }
  }

  private emitDiagnostic(entry: ModelCallEntry): Promise<void> {
    const sink = this.onDiagnostic;
    if (!sink) return Promise.resolve();
    return Promise.resolve()
      .then(() => sink(entry))
      .catch(() => {
        /* diagnostic sink failure must not crash the worker */
      });
  }

  private sleep(ms?: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms ?? this.pollIntervalMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
