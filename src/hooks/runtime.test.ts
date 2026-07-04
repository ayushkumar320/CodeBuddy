import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFileStore } from "../core/memory-file-store.js";
import { extractEditedPaths, runCaptureHook, runContextHook, runStageHook } from "./runtime.js";
import { HookStagingStore } from "./staging.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-hooks-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("HookStagingStore", () => {
  it("accumulates unique paths per session and drains them", async () => {
    const root = await tempRepo();
    const store = new HookStagingStore(root);
    await store.add("sess1", ["a.ts", "b.ts"]);
    await store.add("sess1", ["a.ts", "c.ts"]);
    expect(await store.read("sess1")).toEqual(["a.ts", "b.ts", "c.ts"]);

    const drained = await store.drain("sess1");
    expect(drained).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(await store.read("sess1")).toEqual([]); // cleared
  });

  it("keeps sessions separate", async () => {
    const root = await tempRepo();
    const store = new HookStagingStore(root);
    await store.add("s1", ["a.ts"]);
    await store.add("s2", ["b.ts"]);
    expect(await store.read("s1")).toEqual(["a.ts"]);
    expect(await store.read("s2")).toEqual(["b.ts"]);
  });
});

describe("extractEditedPaths", () => {
  it("reads file_path from Edit/Write and edits[] from MultiEdit", () => {
    expect(extractEditedPaths({ file_path: "/x/a.ts" })).toEqual(["/x/a.ts"]);
    expect(
      extractEditedPaths({ edits: [{ file_path: "/x/a.ts" }, { file_path: "/x/b.ts" }] }),
    ).toEqual(["/x/a.ts", "/x/b.ts"]);
    expect(extractEditedPaths(undefined)).toEqual([]);
  });
});

describe("runStageHook", () => {
  it("stages edited files as repo-relative paths", async () => {
    const root = await tempRepo();
    const staged = await runStageHook({
      cwd: root,
      session_id: "s1",
      tool_input: { file_path: join(root, "src", "auth.ts") },
    });
    expect(staged).toEqual(["src/auth.ts"]);
    expect(await new HookStagingStore(root).read("s1")).toEqual(["src/auth.ts"]);
  });
});

describe("runContextHook", () => {
  it("returns a bounded, informative context block", async () => {
    const root = await tempRepo();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");

    const block = await runContextHook({ cwd: root });
    expect(block).toContain("CodeBuddy project context");
    expect(block).toContain(`project: ${basename(root)}`);
    expect(block.length).toBeLessThanOrEqual(1800);
  });
});

describe("runCaptureHook", () => {
  it("captures durable memory from the staged change set and clears staging", async () => {
    const root = await tempRepo();
    await new HookStagingStore(root).add("s1", ["src/upload.ts"]);

    // A transcript whose last assistant message describes a real incident.
    const transcript = join(root, "transcript.jsonl");
    await writeFile(
      transcript,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "fix it" } }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "The upload crashed; root cause was an unclosed stream." },
            ],
          },
        }),
      ].join("\n"),
    );

    const { changedFiles, result } = await runCaptureHook({
      cwd: root,
      session_id: "s1",
      transcript_path: transcript,
    });

    expect(changedFiles).toEqual(["src/upload.ts"]);
    expect(result).not.toBeNull();
    expect(result?.saved.some((d) => d.candidate.class === "incident")).toBe(true);

    // Staging is cleared, and a durable incident fact was written.
    expect(await new HookStagingStore(root).read("s1")).toEqual([]);
    const facts = await new MemoryFileStore(root).listFacts();
    expect(facts.some((f) => f.category === "incident")).toBe(true);
  });

  it("does nothing when no files were staged", async () => {
    const root = await tempRepo();
    const { changedFiles, result } = await runCaptureHook({ cwd: root, session_id: "empty" });
    expect(changedFiles).toEqual([]);
    expect(result).toBeNull();
  });
});
