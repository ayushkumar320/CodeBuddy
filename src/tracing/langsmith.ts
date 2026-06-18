export type TraceMetadata = Record<string, unknown>;

export function isLangSmithTracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LANGCHAIN_TRACING_V2 === "true";
}
