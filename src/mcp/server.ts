import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pino from "pino";
import { createRuntime } from "../core/operations.js";
import type { CodeBuddyConfig } from "../core/types.js";
import { registerCodeBuddyTools } from "./tools/index.js";

export type StartMcpServerOptions = {
  config?: CodeBuddyConfig;
};

export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<void> {
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" }, process.stderr);
  const runtime = await createRuntime(options.config, { autoBootstrap: true });
  const server = new McpServer({ name: "codebuddy", version: "2.0.0" });
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
