import { describe, expect, it, vi } from "vitest";
import { createCoalescer } from "./watch.js";

describe("createCoalescer", () => {
  it("collapses a burst of triggers into a single run", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn(async () => {});
      const coalescer = createCoalescer(fn, 100);

      coalescer.trigger();
      coalescer.trigger();
      coalescer.trigger();
      expect(fn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs again for triggers that arrive after the window", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn(async () => {});
      const coalescer = createCoalescer(fn, 50);

      coalescer.trigger();
      await vi.advanceTimersByTimeAsync(50);
      coalescer.trigger();
      await vi.advanceTimersByTimeAsync(50);

      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() cancels a pending run", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn(async () => {});
      const coalescer = createCoalescer(fn, 100);
      coalescer.trigger();
      coalescer.stop();
      await vi.advanceTimersByTimeAsync(200);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
