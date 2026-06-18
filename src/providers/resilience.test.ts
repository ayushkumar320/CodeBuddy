import { describe, expect, it, vi } from "vitest";
import type { ProviderCallMetadata } from "./adapter.js";
import { GatedModelError, HuggingFaceResilience } from "./resilience.js";

function hfError(status: number, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(`HF ${status}`), { status, ...extra });
}

describe("HuggingFaceResilience", () => {
  it("waits for cold starts before retrying", async () => {
    const sleep = vi.fn(async () => undefined);
    const call = vi
      .fn<(model: string) => Promise<string>>()
      .mockRejectedValueOnce(hfError(503, { estimated_time: 3 }))
      .mockResolvedValueOnce("ok");

    const resilience = new HuggingFaceResilience({
      retries: 2,
      coldStartBufferMs: 2_000,
      jitterMs: 0,
      minRetryTimeoutMs: 1,
      maxRetryTimeoutMs: 1,
    });

    await expect(
      resilience.execute({
        model: "primary",
        type: "llm",
        call,
        sleep,
      }),
    ).resolves.toBe("ok");

    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("respects retry-after for rate limits", async () => {
    const sleep = vi.fn(async () => undefined);
    const call = vi
      .fn<(model: string) => Promise<string>>()
      .mockRejectedValueOnce(
        hfError(429, {
          response: {
            status: 429,
            headers: {
              get: (name: string) => (name.toLowerCase() === "retry-after" ? "7" : null),
            },
          },
        }),
      )
      .mockResolvedValueOnce("ok");

    const resilience = new HuggingFaceResilience({
      retries: 2,
      jitterMs: 0,
      minRetryTimeoutMs: 1,
      maxRetryTimeoutMs: 1,
    });

    await expect(
      resilience.execute({
        model: "primary",
        type: "embedding",
        call,
        sleep,
      }),
    ).resolves.toBe("ok");

    expect(sleep).toHaveBeenCalledWith(7_000);
  });

  it("treats gated models as hard failures without fallback", async () => {
    const call = vi.fn<(model: string) => Promise<string>>().mockRejectedValue(hfError(403));

    const resilience = new HuggingFaceResilience({ retries: 3 });

    await expect(
      resilience.execute({
        model: "meta-llama/Llama-3.2-3B-Instruct",
        fallbackModels: ["Qwen/Qwen2.5-7B-Instruct"],
        type: "llm",
        call,
      }),
    ).rejects.toBeInstanceOf(GatedModelError);

    expect(call).toHaveBeenCalledTimes(1);
  });

  it("falls back after unavailable models fail", async () => {
    const diagnostics: ProviderCallMetadata[] = [];
    const call = vi
      .fn<(model: string) => Promise<string>>()
      .mockRejectedValueOnce(hfError(404))
      .mockResolvedValueOnce("fallback-ok");

    const resilience = new HuggingFaceResilience({ retries: 0 });

    await expect(
      resilience.execute({
        model: "primary",
        fallbackModels: ["fallback"],
        type: "llm",
        call,
        onDiagnostic: (metadata) => {
          diagnostics.push(metadata);
        },
      }),
    ).resolves.toBe("fallback-ok");

    expect(call).toHaveBeenNthCalledWith(1, "primary");
    expect(call).toHaveBeenNthCalledWith(2, "fallback");
    expect(diagnostics.some((metadata) => metadata.fallbackTriggered)).toBe(true);
  });

  it("reports timeouts through diagnostics", async () => {
    const diagnostics: ProviderCallMetadata[] = [];
    const call = vi.fn<(model: string) => Promise<string>>(() => new Promise(() => undefined));

    const resilience = new HuggingFaceResilience({ retries: 0, timeoutMs: 1 });

    await expect(
      resilience.execute({
        model: "primary",
        type: "embedding",
        call,
        onDiagnostic: (metadata) => {
          diagnostics.push(metadata);
        },
      }),
    ).rejects.toThrow();

    expect(diagnostics.at(-1)?.status).toBe("timeout");
  });
});
