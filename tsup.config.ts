import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli/index": "src/cli/index.ts",
    "langgraph/index": "src/langgraph/index.ts",
  },
  format: ["esm"],
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
});
