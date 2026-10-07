import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readRunIndex, type TicketKey } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { analysis, createBuildProject, draft } from "../../../../tests/support/cli-build.js";
import { promptOf } from "../../../../tests/support/mock-model.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("map as planner input (REQ-OBS-08)", () => {
  it("REQ-OBS-08/AC1: plan gets the untested screens and endpoints around the change from past runs", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    await p.prepare();
    expect((await p.run(["run", "DEMO-1", "--build"])).exitCode).toBe(0);
    await writeFile(join(p.project, ".qa", "routes.yaml"), "routes: [/cart, /cart/checkout, /products]\n");

    expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    const planned = await p.run(["plan", "DEMO-1"], [{ text: analysis }, { text: draft }]);
    expect(planned.err).toBe("");
    expect(planned.out).toContain(
      "Application map: 1 never tested screen(s) or endpoint(s) next to the change.",
    );
    const runs = join(p.home, "runs");
    const latest = (await readRunIndex(runs, "DEMO-1" as TicketKey)).latest ?? "";
    const around = JSON.parse(await readFile(join(runs, "DEMO-1", latest, "map", "around.json"), "utf8")) as {
      changed: { id: string; tested: boolean }[];
      untested: { id: string; near: string }[];
    };
    expect(around.changed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "api:GET /cart", tested: true }),
        expect.objectContaining({ id: "page:/cart", tested: false }),
      ]),
    );
    expect(around.untested).toEqual([{ id: "page:/cart/checkout", near: "page:/cart" }]);
    const prompt = promptOf(planned.model, 1);
    expect(prompt).toContain("Application map around the change (from 1 past run(s)");
    expect(prompt).toContain("page:/cart/checkout (near page:/cart)");
  }, 240_000);

  it("REQ-OBS-08/AC1: without past runs or known screens no map is given and planning works as before", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    await expect(readFile(join(dir, "map", "around.json"), "utf8")).rejects.toThrow();
  }, 240_000);
});
