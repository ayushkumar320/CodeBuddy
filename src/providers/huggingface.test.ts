import { describe, expect, it, vi } from "vitest";
import { HuggingFaceProvider } from "./huggingface.js";

describe("HuggingFaceProvider", () => {
  it("normalizes a single embedding vector", async () => {
    const provider = new HuggingFaceProvider({
      client: {
        featureExtraction: vi.fn(async () => [0.1, 0.2, 0.3]),
        textGeneration: vi.fn(),
      },
      resilience: {
        retries: 0,
      },
    });

    await expect(provider.embed({ input: "hello" })).resolves.toMatchObject({
      model: "sentence-transformers/all-MiniLM-L6-v2",
      dimensions: 384,
      vectors: [[0.1, 0.2, 0.3]],
    });
  });

  it("normalizes batched embedding vectors", async () => {
    const provider = new HuggingFaceProvider({
      client: {
        featureExtraction: vi.fn(async () => [
          [0.1, 0.2],
          [0.3, 0.4],
        ]),
        textGeneration: vi.fn(),
      },
      resilience: {
        retries: 0,
      },
    });

    await expect(provider.embed({ input: ["hello", "world"] })).resolves.toMatchObject({
      dimensions: 384,
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    });
  });

  it("generates text through the default primary model", async () => {
    const textGeneration = vi.fn(async () => ({ generated_text: "hello back" }));
    const provider = new HuggingFaceProvider({
      client: {
        featureExtraction: vi.fn(),
        textGeneration,
      },
      resilience: {
        retries: 0,
      },
    });

    await expect(provider.generateText({ prompt: "hello" })).resolves.toMatchObject({
      model: "meta-llama/Llama-3.2-3B-Instruct",
      text: "hello back",
    });

    expect(textGeneration).toHaveBeenCalledWith({
      model: "meta-llama/Llama-3.2-3B-Instruct",
      inputs: "hello",
    });
  });
});
