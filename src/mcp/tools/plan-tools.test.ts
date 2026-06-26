import { describe, expect, it } from "vitest";
import { mcpToolInputSchemas } from "./index.js";

describe("plan MCP tool schemas", () => {
  it("plan_current takes no input", () => {
    expect(mcpToolInputSchemas.plan_current.parse({})).toEqual({});
  });

  it("plan_create requires title and brief", () => {
    const parsed = mcpToolInputSchemas.plan_create.parse({
      title: "Add OAuth",
      brief: "Google sign-in",
    });
    expect(parsed.title).toBe("Add OAuth");
    expect(parsed.brief).toBe("Google sign-in");
  });

  it("plan_create rejects a missing brief", () => {
    expect(() => mcpToolInputSchemas.plan_create.parse({ title: "x" })).toThrow();
  });

  it("plan_create accepts structured files and tests", () => {
    const parsed = mcpToolInputSchemas.plan_create.parse({
      title: "x",
      brief: "y",
      filesToTouch: [{ path: "src/a.ts", action: "create" }],
      testsToAdd: [{ path: "src/a.test.ts" }],
      outOfScope: ["logout"],
      risks: ["rate limit"],
    });
    expect(parsed.filesToTouch?.[0]?.action).toBe("create");
    expect(parsed.testsToAdd?.[0]?.path).toBe("src/a.test.ts");
  });

  it("plan_create rejects an unknown file action", () => {
    expect(() =>
      mcpToolInputSchemas.plan_create.parse({
        title: "x",
        brief: "y",
        filesToTouch: [{ path: "src/a.ts", action: "rename" }],
      }),
    ).toThrow();
  });

  it("plan_amend requires an id and a patch object", () => {
    const parsed = mcpToolInputSchemas.plan_amend.parse({
      id: "pln_01abc",
      patch: { brief: "scope grew" },
    });
    expect(parsed.id).toBe("pln_01abc");
    expect(parsed.patch.brief).toBe("scope grew");
  });

  it("plan_status only accepts the four transition targets", () => {
    for (const status of ["approved", "executing", "complete", "abandoned"]) {
      expect(mcpToolInputSchemas.plan_status.parse({ id: "pln_01abc", status }).status).toBe(
        status,
      );
    }
    expect(() =>
      mcpToolInputSchemas.plan_status.parse({ id: "pln_01abc", status: "draft" }),
    ).toThrow();
  });

  it("plan_status carries optional commit and reason", () => {
    const parsed = mcpToolInputSchemas.plan_status.parse({
      id: "pln_01abc",
      status: "complete",
      commitSha: "abc123",
    });
    expect(parsed.commitSha).toBe("abc123");
  });
});
