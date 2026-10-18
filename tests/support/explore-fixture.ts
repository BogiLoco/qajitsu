import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { RunWorkspace } from "@qajitsu/core";

/**
 * Writes a browser session S01 into a run with a person's review of it, as `qj explore` and `qj explore review` do
 * (REQ-PLAN-11): items O1 (observation), F1 (finding) and C1 (not done); `accepted` lists the items accepted.
 *
 * @param ws - The run.
 * @param accepted - Items accepted by the person; the others are rejected.
 */
export async function writeReviewedSession(ws: RunWorkspace, accepted: readonly string[]): Promise<void> {
  const session = JSON.stringify({
    schema: 1,
    id: "S01",
    ticket: ws.ticket,
    run: ws.runId,
    goal: "Cart around the discount change",
    environment: { name: "local", baseUrl: "http://127.0.0.1:3000" },
    model: "m",
    startedAt: "t0",
    endedAt: "t1",
    endReason: "finished",
    budget: { minutes: 10, steps: 10 },
    checklist: [{ item: "apply a code twice", source: "person", actions: [], notDone: "budget used" }],
    findings: [{ text: "the total keeps three decimals after a discount", actions: ["A01"] }],
    actions: [
      { id: "A01", action: "goto", target: "/app/cart", ok: true, url: "http://x/app/cart", at: "t" },
    ],
    observations: [
      {
        id: "O1",
        title: "Total has three decimals",
        kind: "possible-bug",
        severity: "medium",
        description: "The total shows 1.005.",
        steps: ["A01"],
        expected: "",
        actual: "1.005",
      },
    ],
    recordings: [],
  });
  await mkdir(ws.path("explore", "S01"), { recursive: true });
  await writeFile(ws.path("explore", "S01", "session.json"), session);
  await writeFile(
    ws.path("explore", "S01", "review.json"),
    JSON.stringify({
      schema: 1,
      session: "S01",
      sessionSha256: createHash("sha256").update(session).digest("hex"),
      decisions: ["O1", "F1", "C1"].map((item) => ({
        item,
        decision: accepted.includes(item) ? "accepted" : "rejected",
        by: "qa-lead",
        at: "t",
      })),
    }),
  );
}
