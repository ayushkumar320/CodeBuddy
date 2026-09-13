import { resolve } from "node:path";
import type { CodeBuddy } from "../core/codebuddy.js";
import { indexRepository } from "../indexer/engine.js";
import { watchRepository } from "../indexer/watch.js";
import { generateGraphifyGraph } from "../integrations/graphify.js";

export type ProjectSyncOptions = {
  repositoryRoot: string;
  memory: CodeBuddy;
  graphify?: { enabled: boolean; graphPath?: string | undefined };
  logger?: Pick<Console, "info" | "error">;
};

export type ProjectSyncHandle = {
  ready: Promise<void>;
  close(): Promise<void>;
};

/**
 * Owns all derived project state. A running MCP server should never require a
 * user or an agent to remember `index`, `graphify`, or `reindex` commands.
 */
export function startProjectSync(options: ProjectSyncOptions): ProjectSyncHandle {
  const repositoryRoot = resolve(options.repositoryRoot);
  const logger = options.logger ?? console;
  const controller = new AbortController();
  let watcher: Promise<void> | null = null;

  const ready = (async () => {
    // The order matters: the index and Markdown import are the useful
    // fallbacks if Graphify is unavailable in a pre-made repository.
    await indexRepository({ repositoryRoot });
    await options.memory.reindexMemory();
    if (options.graphify?.enabled) {
      await refreshGraph().catch((error) =>
        logger.error(`[sync] Graphify startup refresh failed: ${(error as Error).message}`),
      );
    }

    watcher = watchRepository({
      repositoryRoot,
      signal: controller.signal,
      onIndex: () => {
        if (options.graphify?.enabled) {
          void refreshGraph().catch((error) =>
            logger.error(`[sync] Graphify refresh failed: ${(error as Error).message}`),
          );
        }
      },
      onError: (error) => logger.error(`[sync] repository watch failed: ${error.message}`),
    });
    // watchRepository performs its own initial index. It is intentionally
    // detached after the awaited startup pass so MCP can accept requests.
    // A platform without recursive fs.watch still gets a healthy MCP server
    // and the completed startup index.
    void watcher.catch((error) =>
      logger.error(`[sync] live repository watch unavailable: ${(error as Error).message}`),
    );
  })().catch((error) => {
    logger.error(`[sync] startup synchronization failed: ${(error as Error).message}`);
    throw error;
  });

  async function refreshGraph(): Promise<void> {
    const result = await generateGraphifyGraph({
      repositoryRoot,
      ...(options.graphify?.graphPath ? { graphPath: options.graphify.graphPath } : {}),
    });
    logger.info(`[sync] Graphify updated (${result.nodes} nodes, ${result.edges} edges)`);
  }

  return {
    ready,
    async close() {
      controller.abort();
      await watcher?.catch(() => undefined);
    },
  };
}
