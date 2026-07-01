/**
 * The one place token counts are estimated. A deterministic ~4-characters-per-
 * token heuristic — no tokenizer dependency, no network — so every savings
 * number in the system is reproducible and comparable. Objects are measured by
 * their JSON serialization, which matches how they travel over MCP.
 */

const CHARS_PER_TOKEN = 4;

export function estimateTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
