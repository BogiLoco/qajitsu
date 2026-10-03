import { createRequire } from "node:module";

/** Reads the CLI version from package.json (works from src/ and dist/, both one level below the package root). */
export function readVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}
