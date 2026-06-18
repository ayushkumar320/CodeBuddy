export type ResilienceOptions = {
  retries: number;
  concurrency: number;
  rateLimitPerMinute: number;
  timeoutMs: number;
};

export const DEFAULT_RESILIENCE_OPTIONS: ResilienceOptions = {
  retries: 5,
  concurrency: 2,
  rateLimitPerMinute: 10,
  timeoutMs: 90_000,
};
