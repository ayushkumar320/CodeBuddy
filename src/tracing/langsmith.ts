export type TraceMetadata = Record<string, unknown>;

export type TraceSpan = {
  end(metadata?: TraceMetadata): void;
  fail(error: unknown, metadata?: TraceMetadata): void;
};

export type Tracer = {
  enabled: boolean;
  startSpan(name: string, input?: TraceMetadata): TraceSpan;
  withSpan<T>(name: string, input: TraceMetadata, fn: () => Promise<T>): Promise<T>;
};

export function isLangSmithTracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LANGCHAIN_TRACING_V2 === "true" || env.LANGSMITH_TRACING === "true";
}

export function createTracer(env: NodeJS.ProcessEnv = process.env): Tracer {
  const enabled = isLangSmithTracingEnabled(env);
  if (!enabled) {
    return {
      enabled: false,
      startSpan: () => noopSpan,
      withSpan: async (_name, _input, fn) => fn(),
    };
  }
  return {
    enabled: true,
    startSpan(name, input) {
      const started = Date.now();
      log("span:start", { name, input });
      return {
        end(metadata) {
          log("span:end", { name, durationMs: Date.now() - started, metadata });
        },
        fail(error, metadata) {
          log("span:fail", {
            name,
            durationMs: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
            metadata,
          });
        },
      };
    },
    async withSpan(name, input, fn) {
      const span = this.startSpan(name, input);
      try {
        const result = await fn();
        span.end();
        return result;
      } catch (error) {
        span.fail(error);
        throw error;
      }
    },
  };
}

const noopSpan: TraceSpan = {
  end: () => undefined,
  fail: () => undefined,
};

function log(event: string, payload: TraceMetadata): void {
  if (process.env.NODE_ENV === "test") return;
  process.stderr.write(`${JSON.stringify({ at: "tracer", event, ...payload })}\n`);
}
