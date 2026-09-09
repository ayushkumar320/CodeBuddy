import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pino from "pino";
import { loadRuntimeConfig } from "../core/config-file.js";
import { createRuntime } from "../core/operations.js";
import type { CodeBuddyConfig } from "../core/types.js";
import { generateGraphifyGraph } from "../integrations/graphify.js";
import { VERSION } from "../version.js";
import { registerCodeBuddyTools } from "./tools/index.js";

export type StartMcpServerOptions = {
  config?: CodeBuddyConfig;
};

export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<void> {
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" }, process.stderr);
  const config = options.config ?? (await loadRuntimeConfig());
  const projectRoot = config.projectRoot ?? process.env.CODEBUDDY_PROJECT_ROOT ?? process.cwd();
  if (config.graphify?.enabled) {
    try {
      const graph = await generateGraphifyGraph({
        repositoryRoot: projectRoot,
        ...(config.graphify.graphPath ? { graphPath: config.graphify.graphPath } : {}),
      });
      logger.info({ nodes: graph.nodes, edges: graph.edges }, "Graphify graph ready");
    } catch (error) {
      throw new Error(
        `Graphify is enabled but its graph could not be prepared for ${projectRoot}. Install graphifyy and check the project files: ${(error as Error).message}`,
      );
    }
  }
  const runtime = await createRuntime(config, { autoBootstrap: true });
  const server = new McpServer({ name: "codebuddy", version: VERSION });
  registerCodeBuddyTools(server, {
    memory: runtime.memory,
    repository: runtime.repository,
  });

  const shutdown = async () => {
    logger.info("codebuddy MCP server shutting down");
    await server.close();
    await runtime.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

  await server.connect(new StdioServerTransport());
  logger.info("codebuddy MCP server started over stdio");
}
