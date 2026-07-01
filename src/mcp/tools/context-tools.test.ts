import { describe, expect, it } from "vitest";
import { mcpToolInputSchemas } from "./index.js";

describe("context MCP tool schemas", () => {
  it("context_bootstrap takes no input", () => {
    expect(mcpToolInputSchemas.context_bootstrap.parse({})).toEqual({});
  });

  it("context_before_edit accepts an empty object (all fields optional)", () => {
    expect(mcpToolInputSchemas.context_before_edit.parse({})).toEqual({});
  });

  it("context_before_edit accepts task, paths, planId, and useGit", () => {
    const parsed = mcpToolInputSchemas.context_before_edit.parse({
      task: "fix OAuth callback",
      paths: ["src/auth/oauth.ts"],
      planId: "pln_01abc",
      useGit: true,
    });
    expect(parsed.task).toBe("fix OAuth callback");
    expect(parsed.paths).toEqual(["src/auth/oauth.ts"]);
    expect(parsed.planId).toBe("pln_01abc");
    expect(parsed.useGit).toBe(true);
  });

  it("context_before_edit rejects an empty path string", () => {
    expect(() => mcpToolInputSchemas.context_before_edit.parse({ paths: [""] })).toThrow();
  });

  it("context_before_edit rejects a non-boolean useGit", () => {
    expect(() => mcpToolInputSchemas.context_before_edit.parse({ useGit: "yes" })).toThrow();
  });

  it("context_after_turn requires a summary", () => {
    expect(() => mcpToolInputSchemas.context_after_turn.parse({})).toThrow();
    const parsed = mcpToolInputSchemas.context_after_turn.parse({
      summary: "fixed the OAuth callback",
      changedFiles: ["src/auth/oauth.ts"],
      planId: "pln_01abc",
      taskType: "bugfix",
    });
    expect(parsed.summary).toBe("fixed the OAuth callback");
    expect(parsed.changedFiles).toEqual(["src/auth/oauth.ts"]);
  });
});
