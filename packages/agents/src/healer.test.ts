import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { PlanSchema, createEventLog } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { promptOf, scriptedModel } from "../../../tests/support/mock-model.js";
import { createFetchedRun } from "../../../tests/support/run-fixture.js";
import { healSpec } from "./healer.js";
import type { AgentStageDeps } from "./roles-run.js";
import { createUsageTracker } from "./usage.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-5",
  version: 1,
  ...JSON.parse(readFileSync(new URL("../../../fixtures/plans/demo-5-draft.json", import.meta.url), "utf8")),
});
const original = readFileSync(
  new URL("../../../fixtures/specs/demo-5/TC-01.spec.ts", import.meta.url),
  "utf8",
);
const broken = original.replace('"testid:place-order"', '"css:#place-order-old"');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const setup = async (answer: string) => {
  const { root, ws } = await createFetchedRun();
  roots.push(root);
  await mkdir(ws.path("specs"), { recursive: true });
  const specFile = ws.path("specs", "TC-01.spec.ts");
  await writeFile(specFile, broken);
  const model = scriptedModel([{ text: answer }]);
  const events = createEventLog({
    ticket: "DEMO-5",
    run: ws.runId,
    write: () => undefined,
    now: () => new Date(0),
    mask: (v) => v,
  });
  const deps: AgentStageDeps = {
    ws,
    models: { forRole: () => Promise.resolve(model), resolve: () => Promise.resolve(model) },
    events,
    usage: createUsageTracker({ events }),
    now: () => new Date(0),
    maskJson: (v) => v,
    maskText: (t) => t,
  };
  return { deps, specFile, model, ws };
};

describe("healer (REQ-EXEC-09)", () => {
  it("REQ-EXEC-09/AC1: a heal that only changes selectors is written to specs/healed; the original stays", async () => {
    const { deps, specFile, model } = await setup("```ts\n" + original + "```");
    const result = await healSpec(deps, plan, {
      caseId: "TC-01",
      specFile,
      error: "locator('#place-order-old') timeout",
      dom: "<button data-testid=place-order>",
      attempt: 1,
    });
    expect(result.problems).toEqual([]);
    expect(result.file).toMatch(/specs\/healed\/v1\/TC-01\.spec\.ts$/);
    expect(await readFile(result.file!, "utf8")).toBe(original);
    expect(await readFile(specFile, "utf8")).toBe(broken);
    expect(promptOf(model, 0)).toContain('<untrusted_data source=\\"dom\\">');
  });

  it("REQ-EXEC-09/AC2: a heal that touches verify() or adds try/catch is rejected", async () => {
    const cheat = broken.replace(/verify\(\s*"S3",\s*"fields\.lines\.length"[\s\S]*?\);\n/, "");
    expect(cheat).not.toBe(broken);
    const { deps, specFile } = await setup("```ts\n" + cheat + "```");
    const result = await healSpec(deps, plan, { caseId: "TC-01", specFile, error: "timeout", attempt: 1 });
    expect(result.file).toBeUndefined();
    expect(result.problems.map((p) => p.check)).toContain("assertion-lock");
    const swallow = await setup(
      "```ts\n" +
        broken.replace(
          'await ui.click("css:#place-order-old");',
          'try { await ui.click("css:#place-order-old"); } catch {}',
        ) +
        "```",
    );
    expect(
      (
        await healSpec(swallow.deps, plan, {
          caseId: "TC-01",
          specFile: swallow.specFile,
          error: "timeout",
          attempt: 2,
        })
      ).file,
    ).toBeUndefined();
    const none = await setup("I cannot help");
    expect(
      (
        await healSpec(none.deps, plan, {
          caseId: "TC-01",
          specFile: none.specFile,
          error: "timeout",
          attempt: 1,
        })
      ).problems[0]?.check,
    ).toBe("lint");
  });
});
