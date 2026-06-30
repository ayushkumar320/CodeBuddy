import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFileStore } from "../../core/memory-file-store.js";
import { RiskAssessor } from "../assessor.js";
import { createIncidentSignal } from "./incident.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-incident-signal-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createIncidentSignal", () => {
  it("turns structured incident memory into risk evidence", async () => {
    const root = await temporaryRoot();
    const store = new MemoryFileStore(root);
    await store.writeFact({
      id: "fact_01incident",
      namespace: "demo",
      subject: "src/auth/oauth.ts",
      predicate: "caused",
      object: "login regression",
      confidence: 1,
      createdAt: "2026-06-25T10:00:00.000Z",
      createdByAgent: "codex",
      sourceInteractionId: null,
      sourceDeleted: false,
      category: "incident",
      paths: ["src/auth/oauth.ts"],
      severity: "high",
      content: "OAuth callback validation caused a login regression.",
    });

    const assessor = new RiskAssessor([createIncidentSignal({ store })]);
    const assessment = await assessor.assess({
      paths: ["src/auth/oauth.ts", "src/ui/button.ts"],
      repositoryRoot: root,
      namespace: "demo",
    });

    expect(assessment.items).toHaveLength(1);
    expect(assessment.items[0]).toMatchObject({
      path: "src/auth/oauth.ts",
      category: "incident",
      score: 80,
      contributingSignals: ["incident-memory"],
    });
    expect(assessment.items[0]?.evidence[0]).toMatchObject({
      kind: "memory_fact",
      factId: "fact_01incident",
    });
  });

  it("ignores resolved incidents unless opted in", async () => {
    const root = await temporaryRoot();
    const store = new MemoryFileStore(root);
    await store.writeFact({
      id: "fact_01resolved",
      namespace: "demo",
      subject: "src/db/repository.ts",
      predicate: "caused",
      object: "data loss",
      confidence: 1,
      createdAt: "2026-06-25T10:00:00.000Z",
      createdByAgent: null,
      sourceInteractionId: null,
      sourceDeleted: false,
      category: "incident",
      paths: ["src/db/repository.ts"],
      severity: "critical",
      resolvedBy: "def456",
      content: "Repository write bug was fixed.",
    });

    const normal = await new RiskAssessor([createIncidentSignal({ store })]).assess({
      paths: ["src/db/repository.ts"],
      repositoryRoot: root,
      namespace: "demo",
    });
    expect(normal.items).toHaveLength(0);

    const withResolved = await new RiskAssessor([
      createIncidentSignal({ store, includeResolved: true }),
    ]).assess({
      paths: ["src/db/repository.ts"],
      repositoryRoot: root,
      namespace: "demo",
    });
    expect(withResolved.items[0]?.score).toBe(95);
  });
});
