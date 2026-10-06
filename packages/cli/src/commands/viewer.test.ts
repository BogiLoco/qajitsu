import { EventEmitter } from "node:events";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";
import { serveRun } from "./viewer.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => {
        resolve(port);
      });
    });
  });

describe("evidence viewer and exports (REQ-PRJ-10)", () => {
  it("REQ-PRJ-10/AC4: serves only report/ and evidence/ of the run, on localhost; never env/, repos/, .. or symlinks out", async () => {
    const p = await createDemoPipeline();
    cleanups.push(p.cleanup);
    await p.executed();
    await mkdir(join(p.runDir, "env"), { recursive: true });
    await writeFile(join(p.runDir, "env", "api.env"), "DEMO_USER_PASSWORD=fictional-demo-password\n");
    await symlink(join(p.runDir, "env", "api.env"), join(p.runDir, "evidence", "linked.env"));
    const viewer = await serveRun(p.runDir);
    cleanups.push(viewer.close);
    expect(viewer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const get = (path: string) => fetch(new URL(path, viewer.url), { redirect: "manual" });
    expect((await get("/")).headers.get("location")).toBe("/report/report.html");
    const report = await get("/report/report.html");
    expect(report.status).toBe(200);
    expect(report.headers.get("content-type")).toContain("text/html");
    expect((await get("/evidence/manifest.json")).status).toBe(200);
    for (const path of [
      "/env/api.env",
      "/repos/shop/cart.ts",
      "/run.json",
      "/journal/events.jsonl",
      "/evidence/linked.env",
      "/report/../env/api.env",
      "/evidence/%2e%2e/env/api.env",
      "/evidence/",
    ])
      expect((await get(path)).status, path).toBe(404);
    expect((await fetch(new URL("/report/report.html", viewer.url), { method: "POST" })).status).toBe(404);
  }, 120_000);

  it("REQ-PRJ-10/AC4: qj evidence --serve opens the run of the resolved project until Ctrl+C", async () => {
    const signals = new EventEmitter();
    const p = await createDemoPipeline();
    cleanups.push(p.cleanup);
    await p.executed();
    const port = await freePort();
    const serving = p.run(["evidence", "DEMO-1", "--serve", "--port", String(port)], { signals });
    for (let i = 0; i < 100; i++) {
      const ok = await fetch(`http://127.0.0.1:${String(port)}/report/report.html`).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await fetch(`http://127.0.0.1:${String(port)}/report/report.html`)).status).toBe(200);
    signals.emit("SIGINT");
    const result = await serving;
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain(`http://127.0.0.1:${String(port)}/`);
  }, 120_000);

  it("REQ-PRJ-10/AC1+AC2: evidence stays in the run workspace; exports go to the project's exports/ by default, never to the current folder", async () => {
    const p = await createDemoPipeline();
    cleanups.push(p.cleanup);
    await p.executed();
    const result = await p.run(["export", "DEMO-1"]);
    expect(result.out).toContain(
      join(p.home, ".qajitsu", "projects", "demo", "exports", "DEMO-1", "20261003-1046-aaaa"),
    );
    expect(
      await readdir(join(p.home, ".qajitsu", "projects", "demo", "exports", "DEMO-1", "20261003-1046-aaaa")),
    ).toEqual(expect.arrayContaining(["report.html", "junit.xml", "DEMO-1_20261003-1046-aaaa_evidence.zip"]));
    expect((await readdir(p.project)).sort()).toEqual([".qa", "tickets"]);
  }, 120_000);
});
