import { describe, expect, it, vi } from "vitest";
import { GroqAuthError, type GroqFetch, GroqProvider, GroqRateLimitError } from "./groq.js";

function okResponse(text: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => text,
    json: async () => ({ choices: [{ message: { content: text } }] }),
  };
}

function errorResponse(status: number, headers: Record<string, string> = {}, body = "boom") {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => ({}),
  };
}

describe("GroqProvider", () => {
  it("embed throws — Groq has no embedding endpoint", async () => {
    const provider = new GroqProvider({ apiKey: "stub" });
    await expect(provider.embed({ input: "x" })).rejects.toThrow(/embedding/i);
  });

  it("generateText returns content on success", async () => {
    const fetchImpl = vi.fn(async () => okResponse("hello from groq")) as unknown as GroqFetch;
    const provider = new GroqProvider({ apiKey: "stub", fetchImpl });
    const result = await provider.generateText({ prompt: "hi" });
    expect(result.text).toBe("hello from groq");
    expect(result.model).toBe("llama-3.3-70b-versatile");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to next model when primary 404s", async () => {
    const responses = [errorResponse(404), okResponse("from fallback")];
    const fetchImpl = vi.fn(
      async () => responses.shift() ?? okResponse("default"),
    ) as unknown as GroqFetch;
    const provider = new GroqProvider({ apiKey: "stub", fetchImpl, retries: 0 });
    const result = await provider.generateText({ prompt: "hi" });
    expect(result.text).toBe("from fallback");
    expect(result.model).toBe("llama-3.1-8b-instant");
  });

  it("surfaces auth errors without retrying or falling back", async () => {
    const fetchImpl = vi.fn(async () => errorResponse(401)) as unknown as GroqFetch;
    const provider = new GroqProvider({ apiKey: "bad", fetchImpl, retries: 5 });
    await expect(provider.generateText({ prompt: "hi" })).rejects.toBeInstanceOf(GroqAuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("emits a 429 as GroqRateLimitError and retries", async () => {
    const responses = [errorResponse(429, { "retry-after": "0" }), okResponse("recovered")];
    const fetchImpl = vi.fn(
      async () => responses.shift() ?? okResponse("default"),
    ) as unknown as GroqFetch;
    const seen: unknown[] = [];
    const provider = new GroqProvider({
      apiKey: "stub",
      fetchImpl,
      retries: 2,
      onDiagnostic: (m) => {
        seen.push(m);
      },
    });
    const result = await provider.generateText({ prompt: "hi" });
    expect(result.text).toBe("recovered");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("missing API key throws GroqAuthError before fetching", async () => {
    const originalEnv = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const fetchImpl = vi.fn() as unknown as GroqFetch;
    const provider = new GroqProvider({ fetchImpl });
    await expect(provider.generateText({ prompt: "x" })).rejects.toBeInstanceOf(GroqAuthError);
    expect(fetchImpl).not.toHaveBeenCalled();
    if (originalEnv !== undefined) process.env.GROQ_API_KEY = originalEnv;
  });

  it("constructs a typed GroqRateLimitError with retryAfterMs", () => {
    const error = new GroqRateLimitError(1500);
    expect(error.retryAfterMs).toBe(1500);
    expect(error.name).toBe("GroqRateLimitError");
  });
});
