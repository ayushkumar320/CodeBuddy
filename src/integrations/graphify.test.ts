import { describe, expect, it } from "vitest";
import { setupGraphify } from "./graphify.js";

describe("setupGraphify", () => {
  it("detects Graphify and registers its assistant skill", async () => {
    const calls: string[] = [];
    const result = await setupGraphify({
      repositoryRoot: "/tmp/project",
      run: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        return { stdout: "graphify 1.0.0", stderr: "" };
      },
    });

    expect(result.available).toBe(true);
    expect(result.installed).toBe(false);
    expect(calls).toEqual(["graphify --version", "graphify install"]);
  });
});
