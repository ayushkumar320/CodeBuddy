import pkg from "../package.json" with { type: "json" };

/**
 * The single source of truth for the product version. `package.json` is the
 * canonical value (npm reads it for the published package); the CLI `--version`
 * flag and the MCP server handshake both import it from here so a version bump
 * only ever touches `package.json`. The bundler inlines this at build time, so
 * there is no runtime file read.
 */
export const VERSION: string = pkg.version;
