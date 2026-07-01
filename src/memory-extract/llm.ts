import { z } from "zod";
import { deterministicExtract } from "./deterministic.js";
import { type ExtractionInput, type MemoryCandidate, memoryCandidateSchema } from "./types.js";

/**
 * LLM-assisted extraction is optional and never trusted blindly. An extractor
 * returns raw JSON; we validate it strictly against the candidate schema and
 * retry a bounded number of times. If it never produces valid output — or no
 * extractor is configured — we fall back to the deterministic parser rather
 * than inventing certainty. Raw LLM output is a suggestion, not a fact.
 */

/** Pluggable model backend. Returns unvalidated candidate JSON. */
export type MemoryExtractor = {
  extract(input: ExtractionInput): Promise<unknown>;
};

const candidateArraySchema = z.array(memoryCandidateSchema);

export type ExtractOptions = {
  extractor?: MemoryExtractor;
  retries?: number;
};

export type ExtractOutcome = {
  candidates: MemoryCandidate[];
  source: "deterministic" | "llm";
};

export async function extractCandidates(
  input: ExtractionInput,
  options: ExtractOptions = {},
): Promise<ExtractOutcome> {
  if (options.extractor) {
    const validated = await tryLlmExtraction(input, options.extractor, options.retries ?? 2);
    if (validated) return { candidates: validated, source: "llm" };
  }
  return { candidates: deterministicExtract(input), source: "deterministic" };
}

async function tryLlmExtraction(
  input: ExtractionInput,
  extractor: MemoryExtractor,
  retries: number,
): Promise<MemoryCandidate[] | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const parsed = candidateArraySchema.safeParse(await extractor.extract(input));
      if (parsed.success) return parsed.data;
    } catch {
      // Swallow and retry; a throwing extractor is treated like invalid output.
    }
  }
  return null;
}
