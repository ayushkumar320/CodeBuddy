import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeProjectMcpConfig } from "./project-mcp.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("writeProjectMcpConfig", () => {
  it("adds CodeBuddy and Graphify without overwriting other servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-project-mcp-"));
    roots.push(root);
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other", args: [] } } }),
    );

    const result = await writeProjectMcpConfig({
      repositoryRoot: root,
      namespace: "demo",
      graphify: true,
    });
    const config = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    };

    expect(result.servers).toEqual(["codebuddy-demo", "graphify", "other"]);
    expect(config.mcpServers.other?.command).toBe("other");
    expect(config.mcpServers["codebuddy-demo"]?.env?.CODEBUDDY_PROJECT_ROOT).toBe(root);
    expect(config.mcpServers.graphify?.args).toEqual([
      "-m",
      "graphify.serve",
      "graphify-out/graph.json",
    ]);
  });

  it("removes a previously configured Graphify server when disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-project-mcp-"));
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeProjectMcpConfig({ repositoryRoot: root, namespace: "demo", graphify: true });
    await writeProjectMcpConfig({ repositoryRoot: root, namespace: "demo", graphify: false });
    const config = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers.graphify).toBeUndefined();
  });
});
