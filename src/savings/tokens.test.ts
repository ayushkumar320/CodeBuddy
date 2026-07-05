import { describe, expect, it } from "vitest";
import { estimateTokens } from "./tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for null, undefined, and empty string", () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens("")).toBe(0);
  });

  it("uses a ~4-chars-per-token ceiling for strings", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2); // 5 chars -> ceil(5/4)
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });

  it("measures objects by their JSON serialization", () => {
    const value = { a: 1, b: "xy" };
    expect(estimateTokens(value)).toBe(Math.ceil(JSON.stringify(value).length / 4));
  });

  it("is deterministic for the same input", () => {
    expect(estimateTokens("hello world")).toBe(estimateTokens("hello world"));
  });
});
