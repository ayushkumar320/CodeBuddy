import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFileStore } from "../core/memory-file-store.js";
import {
  deriveSummary,
  extractEditedPaths,
  lastAssistantMessage,
  runCaptureHook,
  runContextHook,
  runStageHook,
} from "./runtime.js";
import { HookStagingStore } from "./staging.js";

const FIXTURE_TRANSCRIPT = fileURLToPath(
  new URL("./__fixtures__/transcript.jsonl", import.meta.url),
);

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

  it("rejects edited paths outside the repository", async () => {
    const root = await tempRepo();
    const staged = await runStageHook({
      cwd: root,
      session_id: "s1",
      tool_input: { file_path: "../../outside.ts" },
    });
    expect(staged).toEqual([]);
    expect(await new HookStagingStore(root).read("s1")).toEqual([]);
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

  it("uses session capsule references on an unchanged second prompt", async () => {
    const root = await tempRepo();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    const input = { cwd: root, session_id: "same", prompt: "review a" };
    const first = await runContextHook(input);
    const second = await runContextHook(input);
    expect(first).not.toContain("capsule:");
    expect(second).toContain("capsule:");
    expect(second).toContain("tokens not resent");
  });
});

describe("transcript extraction", () => {
  it("extracts the last assistant text from a realistic Claude Code transcript", async () => {
    const text = await lastAssistantMessage(FIXTURE_TRANSCRIPT);
    // Skips tool_use-only assistant turns and tool_result user turns, landing on
    // the final natural-language assistant message.
    expect(text).toContain("Root cause");
    expect(text).toContain("file descriptor");
    expect(text).not.toContain("tool_use");
    expect(text).not.toContain("Let me look at the upload handler");
  });

  it("falls back to empty string on malformed JSON lines", async () => {
    const root = await tempRepo();
    const transcript = join(root, "broken.jsonl");
    await writeFile(transcript, '{ not json\n<<garbage>>\n{"type":"assistant"} truncated');
    expect(await lastAssistantMessage(transcript)).toBe("");
  });

  it("returns empty string when the transcript file is missing", async () => {
    expect(await lastAssistantMessage(join(await tempRepo(), "nope.jsonl"))).toBe("");
  });

  it("deriveSummary falls back to a plain file list when no transcript is available", async () => {
    const summary = await deriveSummary(undefined, ["src/a.ts", "src/b.ts"]);
    expect(summary).toBe("Changed files: src/a.ts, src/b.ts.");
  });

  it("deriveSummary prepends assistant text to the file list when a transcript exists", async () => {
    const summary = await deriveSummary(FIXTURE_TRANSCRIPT, ["src/upload.ts"]);
    expect(summary).toContain("Root cause");
    expect(summary.endsWith("Changed files: src/upload.ts.")).toBe(true);
  });

  it("deriveSummary falls back to the file list when the transcript is unreadable", async () => {
    const summary = await deriveSummary(join(await tempRepo(), "missing.jsonl"), ["src/x.ts"]);
    expect(summary).toBe("Changed files: src/x.ts.");
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
