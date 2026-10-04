import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../../../../tests/support/cli-build.js";
import { openApiOperations } from "./map.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("qajitsu map (REQ-OBS-07)", () => {
  it("REQ-OBS-07/AC1+AC2: tested endpoints from runs, untested ones from OpenAPI, as map.json and map.html", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    await p.prepare();
    expect((await p.run(["run", "DEMO-1", "--build"])).exitCode).toBe(0);
    const openapi = fileURLToPath(
      new URL("../../../../examples/demo-shop/api/openapi.yaml", import.meta.url),
    );
    const r = await p.run(["map", "--openapi", openapi]);
    expect(r.exitCode).toBe(0);
    const map = JSON.parse(await readFile(join(p.project, "qa-map", "map.json"), "utf8")) as {
      nodes: { id: string; tested: boolean }[];
      neverTested: string[];
    };
    expect(map.nodes.filter((n) => n.tested).map((n) => n.id)).toEqual(
      expect.arrayContaining(["api:GET /cart"]),
    );
    expect(map.neverTested).toEqual(expect.arrayContaining(["api:POST /orders", "api:GET /me"]));
    expect(map.neverTested).not.toContain("api:GET /cart");
    expect(await readFile(join(p.project, "qa-map", "map.html"), "utf8")).toContain("Never tested");
    expect(r.out).toMatch(/1 run\(s\), \d+ tested node\(s\), \d+ never tested\./);
  }, 120_000);

  it("reads operations from OpenAPI paths", () => {
    expect(
      openApiOperations({
        paths: { "/a": { get: {}, post: {}, parameters: [] }, "/b/{id}": { delete: {} } },
      }),
    ).toEqual(["GET /a", "POST /a", "DELETE /b/{id}"]);
    expect(openApiOperations(null)).toEqual([]);
  });
});
