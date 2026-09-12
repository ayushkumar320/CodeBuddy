import { describe, expect, it } from "vitest";
import { estimateTokens } from "./tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for null, undefined, and empty string", () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens("")).toBe(0);
  });

  it("uses the shared cl100k tokenizer for strings", () => {
    expect(estimateTokens("abcd")).toBeGreaterThan(0);
    expect(estimateTokens("abcde")).toBeGreaterThanOrEqual(estimateTokens("abcd"));
    expect(estimateTokens("a".repeat(40))).toBeGreaterThan(0);
  });

  it("measures objects by their JSON serialization", () => {
    const value = { a: 1, b: "xy" };
    expect(estimateTokens(value)).toBeGreaterThan(0);
  });

  it("is deterministic for the same input", () => {
    expect(estimateTokens("hello world")).toBe(estimateTokens("hello world"));
  });
});
