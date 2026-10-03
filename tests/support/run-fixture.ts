import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TicketKeySchema, createRunWorkspace, type RunWorkspace, type Ticket } from "@qajitsu/core";

/** The DEMO-1 ticket snapshot used across agent tests (fictional, demo-shop). */
export const DEMO_TICKET: Ticket = {
  key: TicketKeySchema.parse("DEMO-1"),
  summary: "Cart total with discount codes",
  description:
    "As a shopper I want the cart total to include my discount code so that I see the final price before checkout.\n\nThe cart endpoint returns line totals and a cart total in PLN with two decimals. One discount code per cart.",
  issueType: "Story",
  status: "Ready for QA",
  labels: ["cart"],
  components: ["shop-api"],
  acceptanceCriteria: [
    "GET /cart returns total = sum of (unit price × quantity) for all lines, rounded once to 2 decimals.",
    "POST /cart/discount with a valid code reduces the total by the code's percentage.",
    "Applying a second code replaces the first; codes never stack.",
    "An unknown code returns 404 with error code DISCOUNT_NOT_FOUND and leaves the total unchanged.",
  ],
  comments: [
    {
      author: "product-owner",
      body: "Codes are percentage only for now; fixed-amount codes come later.",
      created: "2026-09-30T10:12:00Z",
    },
  ],
  linkedKeys: [],
  attachments: [],
  developmentLinks: [],
};

/**
 * Creates a run folder as `qj fetch` leaves it (ticket snapshot, diff, change, worktree files),
 * without git or network.
 */
export async function createFetchedRun(
  options: { ticket?: Ticket; diff?: string; files?: Record<string, string> } = {},
): Promise<{ root: string; ws: RunWorkspace }> {
  const root = await mkdtemp(join(tmpdir(), "qj-run-"));
  const ticket = options.ticket ?? DEMO_TICKET;
  const ws = await createRunWorkspace({
    root,
    ticket: ticket.key,
    now: () => new Date("2026-10-03T12:00:00Z"),
    random: () => 0,
  });
  await writeFile(ws.path("ticket", "ticket.json"), JSON.stringify(ticket));
  const diff =
    options.diff ?? readFileSync(new URL("../../fixtures/github/pull-12.diff", import.meta.url), "utf8");
  await writeFile(ws.path("repos", "shop.diff"), diff);
  await writeFile(
    ws.path("repos", "shop.change.json"),
    JSON.stringify({
      change: {
        host: "github",
        repo: "demo-org/demo-shop",
        kind: "pr",
        id: "12",
        title: "DEMO-1 discount codes",
        description: "Adds codes.",
        headSha: "1".repeat(40),
      },
      comments: [{ author: "reviewer-1", body: "Round once, good.", path: "src/cart/total.ts", line: 3 }],
    }),
  );
  const files = options.files ?? { "src/cart/total.ts": "export function total() {\n  return 1;\n}\n" };
  for (const [path, content] of Object.entries(files)) {
    const abs = ws.path("repos", "shop", path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
  }
  await ws.update({ repos: { shop: { host: "github", path: "demo-org/demo-shop", sha: "1".repeat(40) } } });
  return { root, ws };
}
