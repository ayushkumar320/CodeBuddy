export type CodeBuddyCheckpointerOptions = {
  namespace?: string;
};

export type CheckpointConfig = {
  configurable?: {
    thread_id?: string;
    checkpoint_id?: string;
    [key: string]: unknown;
  };
};

export type CheckpointTuple = {
  config: CheckpointConfig;
  checkpoint: unknown;
  metadata?: unknown;
  parentConfig?: CheckpointConfig;
};

export class CodeBuddyCheckpointer {
  readonly options: CodeBuddyCheckpointerOptions;
  private readonly checkpoints = new Map<string, CheckpointTuple>();

  constructor(options: CodeBuddyCheckpointerOptions = {}) {
    this.options = options;
  }

  async getTuple(config: CheckpointConfig): Promise<CheckpointTuple | undefined> {
    const threadId = requireThreadId(config);
    const checkpointId = config.configurable?.checkpoint_id;
    if (checkpointId) return this.checkpoints.get(key(threadId, checkpointId));
    const tuples = Array.from(this.checkpoints.values())
      .filter((tuple) => tuple.config.configurable?.thread_id === threadId)
      .sort((a, b) =>
        String(b.config.configurable?.checkpoint_id ?? "").localeCompare(
          String(a.config.configurable?.checkpoint_id ?? ""),
        ),
      );
    return tuples[0];
  }

  async put(
    config: CheckpointConfig,
    checkpoint: unknown,
    metadata?: unknown,
    newVersions?: unknown,
  ): Promise<CheckpointConfig> {
    const threadId = requireThreadId(config);
    const checkpointId =
      config.configurable?.checkpoint_id ?? checkpointIdFrom(checkpoint) ?? `ckpt_${Date.now()}`;
    const nextConfig = {
      ...config,
      configurable: {
        ...config.configurable,
        thread_id: threadId,
        checkpoint_id: checkpointId,
      },
    };
    const tuple: CheckpointTuple = {
      config: nextConfig,
      checkpoint,
      metadata: { ...(metadata && typeof metadata === "object" ? metadata : {}), newVersions },
    };
    if (config.configurable?.checkpoint_id) {
      tuple.parentConfig = config;
    }
    this.checkpoints.set(key(threadId, checkpointId), tuple);
    return nextConfig;
  }

  async putWrites(): Promise<void> {
    return;
  }

  async *list(config: CheckpointConfig): AsyncGenerator<CheckpointTuple> {
    const threadId = requireThreadId(config);
    const tuples = Array.from(this.checkpoints.values())
      .filter((tuple) => tuple.config.configurable?.thread_id === threadId)
      .sort((a, b) =>
        String(b.config.configurable?.checkpoint_id ?? "").localeCompare(
          String(a.config.configurable?.checkpoint_id ?? ""),
        ),
      );
    for (const tuple of tuples) yield tuple;
  }
}

function key(threadId: string, checkpointId: string): string {
  return `${threadId}\x1f${checkpointId}`;
}

function requireThreadId(config: CheckpointConfig): string {
  const threadId = config.configurable?.thread_id;
  if (!threadId || typeof threadId !== "string") {
    throw new Error("CodeBuddyCheckpointer requires configurable.thread_id.");
  }
  return threadId;
}

function checkpointIdFrom(checkpoint: unknown): string | undefined {
  if (!checkpoint || typeof checkpoint !== "object") return undefined;
  const value = (checkpoint as { id?: unknown }).id;
  return typeof value === "string" ? value : undefined;
}
