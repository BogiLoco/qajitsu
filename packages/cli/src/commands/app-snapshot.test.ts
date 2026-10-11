import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPlaywrightBrowserFactory } from "@qajitsu/adapter-runner-web";
import type { UiScreen } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const analysis = JSON.stringify({
  summary: "Checkout needs accepted terms.",
  change_type: ["web"],
  screens: [{ name: "Checkout", source: [{ kind: "ac", id: "AC1" }] }],
  confidence: "high",
});

describe("pages of the environment for the planner (REQ-EXEC-22/AC7+AC8)", () => {
  it("REQ-EXEC-22/AC7+AC8: qj plan --snapshot records the pages reachable from the start page, as the account, and checks the plan against them", async () => {
    const p = await createDemoPipeline({
      ticket: "DEMO-4",
      ports: {
        snapshotBrowser: createPlaywrightBrowserFactory({
          video: "off",
          webSession: { storage: "sessionStorage", key: "token" },
          actionTimeoutMs: 3000,
        }),
      },
    });
    cleanups.push(p.cleanup);
    await p.run(["fetch", "DEMO-4", "--ref", "shop=main"]);
    const draft = JSON.parse(
      await readFile(new URL("../../../../fixtures/plans/demo-4-draft.json", import.meta.url), "utf8"),
    ) as {
      cases: { steps: { expect: { elements?: Record<string, unknown> } }[] }[];
    };
    // One expectation names an element no page shows: it is flagged before the person sees the plan.
    const first = draft.cases[0]?.steps[0]?.expect;
    if (first) first.elements = { ...first.elements, "role:button:Buy now": { visible: true } };
    const planned = await p.run(["plan", "DEMO-4", "--snapshot"], {
      script: [{ text: analysis }, { text: JSON.stringify(draft) }, { text: JSON.stringify(draft) }],
    });
    expect(planned.err).toBe("");
    expect(planned.out).toMatch(/Recorded \d+ page\(s\) of local for the planner\./);
    const screens = JSON.parse(await readFile(join(p.runDir, "ui", "snapshot.json"), "utf8")) as UiScreen[];
    expect(screens[0]).toMatchObject({ where: "/", platform: "web", account: "user:standard" });
    const checkout = screens.find((s) => s.where === "/app/checkout");
    expect(checkout?.elements).toContainEqual(expect.objectContaining({ testid: "place-order" }));
    expect(JSON.stringify(screens)).not.toContain("fictional-demo-password");
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toContain('"event":"ui.snapshot"');
    expect(journal).toContain('"event":"plan.quality"');
    expect(planned.out).toContain(
      "role:button:Buy now matches no element recorded on the environment's pages",
    );
  });
});
