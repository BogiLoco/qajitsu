// Every status of the status model has a documented meaning in the architecture overview and in the user docs
// (REQ-VER-01/AC2); a new status without documentation fails here.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEST_STATUSES } from "../../packages/core/src/status.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Table rows `| <status> | <meaning> |` of a Markdown file, keyed by the status without backticks or bold. */
const statusRows = async (path: string): Promise<Map<string, string>> => {
  const rows = new Map<string, string>();
  for (const line of (await readFile(join(root, path), "utf8")).split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const name = cells[1]?.replace(/[`*]/g, "");
    if (name && (TEST_STATUSES as readonly string[]).includes(name)) rows.set(name, cells[2] ?? "");
  }
  return rows;
};

describe("status documentation (REQ-VER-01)", () => {
  it.each(["docs/architecture/overview.md", "README.md"])(
    "REQ-VER-01/AC2: every status has a meaning in %s",
    async (path) => {
      const rows = await statusRows(path);
      for (const status of TEST_STATUSES) expect(rows.get(status), status).toMatch(/\w{3,}/);
    },
  );
});
