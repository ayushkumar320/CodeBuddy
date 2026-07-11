import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFileStore } from "../core/memory-file-store.js";
import { approveReviewItem, captureAfterTurn } from "./engine.js";
import { ReviewStore } from "./review-store.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-capture-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("captureAfterTurn gating", () => {
  it("auto-saves a confident incident but queues notes and low-confidence facts", async () => {
    const root = await tempRepo();
    const result = await captureAfterTurn(
      {
        namespace: "proj",
        summary:
          "The login crashed on callback; root cause was a dropped state param. TODO: add a regression test later. The config uses YAML.",
        changedFiles: ["src/auth/oauth.ts"],
      },
      { repositoryRoot: root },
    );

    expect(result.saved).toHaveLength(1);
    expect(result.saved[0]?.candidate.class).toBe("incident");
    expect(result.queuedForReview.map((d) => d.candidate.class).sort()).toEqual(["fact", "note"]);

    const facts = await new MemoryFileStore(root).listFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]?.category).toBe("incident");
    expect(facts[0]?.paths).toEqual(["src/auth/oauth.ts"]);

    const review = await new ReviewStore(root).list();
    expect(review).toHaveLength(2);
  });

  it("never auto-saves sensitive content, even when confident", async () => {
    const root = await tempRepo();
    const result = await captureAfterTurn(
      {
        namespace: "proj",
        // A confident-looking decision that leaks a token.
        summary: "We decided to hardcode the token hf_abcdefghij0123456789 for now.",
      },
      { repositoryRoot: root },
    );

    expect(result.saved).toHaveLength(0);
    expect(result.queuedForReview).toHaveLength(1);
    expect(result.queuedForReview[0]?.sensitive).toBe(true);

    expect(await new MemoryFileStore(root).listFacts()).toHaveLength(0);
    const queued = await new ReviewStore(root).list();
    expect(queued[0]?.sensitive).toBe(true);
    expect(queued[0]?.sensitiveReasons).toContain("hf-token");
    expect(queued[0]?.content).toBe("[REDACTED SENSITIVE CONTENT]");
    expect(await readFile(queued[0]?.path ?? "", "utf8")).not.toContain("hf_abcdefghij0123456789");
  });

  it("deduplicates replayed durable and review candidates", async () => {
    const root = await tempRepo();
    const incident = {
      namespace: "proj",
      summary: "The login crashed; root cause was a missing state parameter.",
      changedFiles: ["src/auth/oauth.ts"],
    };
    await captureAfterTurn(incident, { repositoryRoot: root });
    await captureAfterTurn(incident, { repositoryRoot: root });
    expect(await new MemoryFileStore(root).listFacts()).toHaveLength(1);

    const note = { namespace: "proj", summary: "TODO: add the callback regression test later." };
    await captureAfterTurn(note, { repositoryRoot: root });
    await captureAfterTurn(note, { repositoryRoot: root });
    expect(await new ReviewStore(root).list()).toHaveLength(1);
  });

  it("persists evidence and resolves an existing incident instead of duplicating it", async () => {
    const root = await tempRepo();
    await captureAfterTurn(
      {
        namespace: "proj",
        summary: "The upload crashed; root cause was an unclosed stream.",
        changedFiles: ["src/upload.ts"],
        sessionId: "sess_1",
        planId: "pln_upload",
        commitSha: "abc123",
        verification: ["npm test passed"],
      },
      { repositoryRoot: root },
    );
    let facts = await new MemoryFileStore(root).listFacts();
    expect(facts[0]?.sourceSessionId).toBe("sess_1");
    expect(facts[0]?.sourcePlanId).toBe("pln_upload");
    expect(facts[0]?.introducedBy).toBe("abc123");
    expect(facts[0]?.verification).toEqual(["npm test passed"]);

    const resolution = await captureAfterTurn(
      {
        namespace: "proj",
        summary: "Fixed the upload crash and verified the fix.",
        changedFiles: ["src/upload.ts"],
      },
      { repositoryRoot: root },
    );
    expect(resolution.reasons.join(" ")).toContain("resolved incident");
    facts = await new MemoryFileStore(root).listFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]?.resolvedBy).not.toBeNull();
  });

  it("marks an explicitly superseded decision as historical", async () => {
    const root = await tempRepo();
    const first = await captureAfterTurn(
      { namespace: "proj", summary: "We decided to use Postgres for durable storage." },
      { repositoryRoot: root },
    );
    const oldId = first.saved[0]?.ref;
    expect(oldId).toMatch(/^fact_/);
    await captureAfterTurn(
      { namespace: "proj", summary: `We decided to use SQLite; supersedes ${oldId}.` },
      { repositoryRoot: root },
    );
    const old = (await new MemoryFileStore(root).listFacts()).find((fact) => fact.id === oldId);
    expect(old?.supersededBy).toMatch(/^fact_/);
  });

  it("drops chatter without saving or queuing", async () => {
    const root = await tempRepo();
    const result = await captureAfterTurn(
      { namespace: "proj", summary: "Thanks for the help today." },
      { repositoryRoot: root },
    );
    expect(result.ignored).toHaveLength(1);
    expect(result.saved).toHaveLength(0);
    expect(result.queuedForReview).toHaveLength(0);
    expect(await new ReviewStore(root).list()).toHaveLength(0);
  });
});

describe("approveReviewItem", () => {
  it("promotes a queued candidate to a durable fact and removes it from the queue", async () => {
    const root = await tempRepo();
    await captureAfterTurn(
      { namespace: "proj", summary: "The config uses YAML." },
      { repositoryRoot: root },
    );
    const queued = await new ReviewStore(root).list();
    expect(queued).toHaveLength(1);

    const factId = await approveReviewItem((queued[0] as { id: string }).id, {
      repositoryRoot: root,
    });
    expect(factId).toMatch(/^fact_/);

    expect(await new ReviewStore(root).list()).toHaveLength(0);
    const facts = await new MemoryFileStore(root).listFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]?.category).toBe("general");
  });
});
