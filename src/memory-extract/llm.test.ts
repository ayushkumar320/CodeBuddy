import { describe, expect, it, vi } from "vitest";
import { extractCandidates, type MemoryExtractor } from "./llm.js";
import type { MemoryCandidate } from "./types.js";

const input = { summary: "The parser uses regex.", namespace: "proj" };

const validCandidate: MemoryCandidate = {
  class: "fact",
  content: "The parser uses regex.",
  subject: "parser",
  predicate: "uses",
  object: "regex",
  confidence: 0.9,
  paths: [],
  severity: null,
};

describe("extractCandidates", () => {
  it("uses deterministic extraction when no extractor is provided", async () => {
    const result = await extractCandidates(input);
    expect(result.source).toBe("deterministic");
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("uses validated LLM output when the extractor returns valid candidates", async () => {
    const extractor: MemoryExtractor = { extract: vi.fn(async () => [validCandidate]) };
    const result = await extractCandidates(input, { extractor });
    expect(result.source).toBe("llm");
    expect(result.candidates).toEqual([validCandidate]);
  });

  it("falls back to deterministic when LLM output never validates", async () => {
    const extractor: MemoryExtractor = { extract: vi.fn(async () => [{ nonsense: true }]) };
    const result = await extractCandidates(input, { extractor, retries: 2 });
    expect(extractor.extract).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(result.source).toBe("deterministic");
  });

  it("falls back to deterministic when the extractor throws", async () => {
    const extractor: MemoryExtractor = {
      extract: vi.fn(async () => {
        throw new Error("model down");
      }),
    };
    const result = await extractCandidates(input, { extractor, retries: 0 });
    expect(result.source).toBe("deterministic");
  });

  it("retries and accepts valid output produced after earlier invalid attempts", async () => {
    let call = 0;
    const extractor: MemoryExtractor = {
      extract: vi.fn(async () => {
        call++;
        return call < 2 ? [{ bad: true }] : [validCandidate];
      }),
    };
    const result = await extractCandidates(input, { extractor, retries: 2 });
    expect(result.source).toBe("llm");
    expect(result.candidates).toEqual([validCandidate]);
  });
});
