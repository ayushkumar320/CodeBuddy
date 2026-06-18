#!/usr/bin/env node
import { Command } from "commander";

export function createCli(): Command {
  const program = new Command();

  program
    .name("codebuddy")
    .description("MCP memory server for multi-agent systems.")
    .version("0.0.0");

  program
    .command("doctor")
    .description("Check CodeBuddy environment health.")
    .action(() => {
      console.log("codebuddy doctor is implemented in Phase 6.");
    });

  return program;
}

createCli().parse();
