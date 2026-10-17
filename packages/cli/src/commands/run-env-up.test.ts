import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startShop } from "../../../../examples/demo-shop/api/server.mjs";
import { createDemoPipeline, DEMO_PASSWORD } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Records a running shop on the run as `qj env up` records the environment it started. */
const envUp = (url: string) => async (runDir: string) => {
  const file = join(runDir, "run.json");
  const record = JSON.parse(await readFile(file, "utf8")) as { data: Record<string, unknown> };
  record.data["build"] = {
    project: "qj-demo-1-test",
    ports: { api: Number(new URL(url).port) },
    services: { api: { kind: "compose", url } },
  };
  await writeFile(file, JSON.stringify(record, null, 2));
};

describe("qajitsu run on the environment qj env up started (REQ-ENV-07/AC3)", () => {
  it("REQ-ENV-07/AC3: without --env or --build, a run uses the environment qj env up started for it while it answers", async () => {
    const shop = await startShop({ env: { DEMO_USER_PASSWORD: DEMO_PASSWORD } });
    cleanups.push(() => shop.close());
    const p = await createDemoPipeline({ beforeRun: envUp(shop.url) });
    cleanups.push(p.cleanup);
    const result = await p.executed();
    expect(result.err).toBe("");
    expect(result.out).toContain(`Using the environment qj env up started for this run: ${shop.url}`);
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toMatch(/"env\.selected".*"via":"env up"/);
  }, 180_000);

  it("REQ-ENV-07/AC1+AC3: an environment env up no longer runs is not used; the default applies", async () => {
    const shop = await startShop({ env: { DEMO_USER_PASSWORD: DEMO_PASSWORD } });
    const p = await createDemoPipeline({
      beforeRun: async (runDir) => {
        await envUp(shop.url)(runDir);
        await shop.close();
      },
    });
    cleanups.push(p.cleanup);
    const result = await p.executed();
    expect(result.out).not.toContain("Using the environment qj env up started");
    expect(result.exitCode).toBe(0);
  }, 180_000);
});
