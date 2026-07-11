import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ReviewItemWrite, ReviewStore } from "./review-store.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-review-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function item(overrides: Partial<ReviewItemWrite> = {}): ReviewItemWrite {
  return {
    id: "rev_01abc",
    namespace: "pathway",
    class: "note",
    subject: "upload",
    predicate: "should",
    object: "close the stream on error",
    confidence: 0.4,
    paths: ["src/upload.ts"],
    severity: null,
    sensitive: false,
    sensitiveReasons: [],
    reason: "low confidence",
    createdAt: "2026-07-05T00:00:00.000Z",
    createdByAgent: "claude",
    sourcePlanId: null,
    content: "Body of the review note.",
    ...overrides,
  };
}

describe("ReviewStore", () => {
  it("writes and reads a review item round-trip", async () => {
    const store = new ReviewStore(await tempRoot());
    await store.write(item());
    const read = await store.read("rev_01abc");
    expect(read.id).toBe("rev_01abc");
    expect(read.object).toBe("close the stream on error");
    expect(read.content).toBe("Body of the review note.");
  });

  it("lists items in stable filename order", async () => {
    const store = new ReviewStore(await tempRoot());
    await store.write(item({ id: "rev_01bbb" }));
    await store.write(item({ id: "rev_01aaa" }));
    expect((await store.list()).map((i) => i.id)).toEqual(["rev_01aaa", "rev_01bbb"]);
  });

  it("returns an empty list when no review directory exists", async () => {
    expect(await new ReviewStore(await tempRoot()).list()).toEqual([]);
  });

  it("deletes an item", async () => {
    const store = new ReviewStore(await tempRoot());
    await store.write(item());
    await store.delete("rev_01abc");
    expect(await store.list()).toEqual([]);
  });

  it("rejects an id that could escape the review directory", async () => {
    const store = new ReviewStore(await tempRoot());
    await expect(store.write(item({ id: "../evil" }))).rejects.toThrow(/Invalid review id/);
    await expect(store.read("../evil")).rejects.toThrow(/Invalid review id/);
  });

  it("preserves sensitivity metadata", async () => {
    const store = new ReviewStore(await tempRoot());
    await store.write(item({ sensitive: true, sensitiveReasons: ["email"] }));
    const read = await store.read("rev_01abc");
    expect(read.sensitive).toBe(true);
    expect(read.sensitiveReasons).toEqual(["email"]);
  });

  it("archives expired items instead of deleting their history", async () => {
    const root = await tempRoot();
    const store = new ReviewStore(root);
    await store.write(item({ createdAt: "2025-01-01T00:00:00.000Z" }));
    expect(
      await store.archiveExpired({ olderThanDays: 30, now: new Date("2026-07-11T00:00:00.000Z") }),
    ).toBe(1);
    expect(await store.list()).toEqual([]);
    expect(
      await readFile(join(root, ".codebuddy", "memory", "review-archive", "rev_01abc.md"), "utf8"),
    ).toContain("Body of the review note.");
  });
});
