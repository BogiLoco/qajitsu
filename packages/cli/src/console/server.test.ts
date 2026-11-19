import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";
import { startConsole } from "./server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const TOKEN = "fictional-console-token-0123456789abcd";

/** A raw request: the path and the Host go out exactly as given (fetch would normalize them). */
const raw = (port: string, path: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });

/** A failed demo run and a console over its home, signed in. */
const setup = async () => {
  const p = await createDemoPipeline({ flag: "BUG_CART_TOTAL_ROUNDING" });
  cleanups.push(p.cleanup);
  expect((await p.executed()).exitCode).toBe(1);
  const server = await startConsole({ env: {}, userHome: p.home, token: TOKEN });
  cleanups.push(server.close);
  const start = new URL(server.url);
  const prefix = start.pathname.replace(/\/signin$/, "");
  const signin = await fetch(server.url, { redirect: "manual" });
  const setCookie = signin.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const get = (path: string) =>
    fetch(`${start.origin}${prefix}${path}`, { headers: { cookie }, redirect: "manual" });
  return { p, server, start, prefix, signin, setCookie, cookie, get };
};
const runPath = "/p/demo/t/DEMO-1/r/20261003-1046-aaaa";

describe("qj console (REQ-WEB-01)", () => {
  it("REQ-WEB-01/AC1+AC2: projects, tickets, runs, a run with its stored statuses, plans, report and evidence", async () => {
    const { get, p, prefix } = await setup();
    const home = await (await get("/")).text();
    // Every link stays under the console's own random path.
    expect(home).toContain(`href="${prefix}/p/demo"`);
    expect(await (await get("/p/demo")).text()).toContain(`href="${prefix}/p/demo/t/DEMO-1"`);
    expect(await (await get("/p/demo/t/DEMO-1")).text()).toContain(`href="${prefix}${runPath}"`);
    const run = await (await get(runPath)).text();
    // The statuses the run computed and stored, never one of the console's own (AC2).
    expect(run).toMatch(/<td>TC-01<\/td><td><span class="s FAILED">FAILED<\/span>/);
    expect(await readFile(join(p.runDir, "run.json"), "utf8")).toMatch(/"TC-01": "FAILED"/);
    expect(run).toContain(`href="${prefix}${runPath}/files/report/report.html"`);
    expect(run).toContain(`href="${prefix}${runPath}/plan/1">v1</a> (approved)`);
    expect(run).toMatch(/Evidence \(\d+ files, by SHA-256\)/);
    const report = await get(`${runPath}/files/report/report.html`);
    expect(report.status).toBe(200);
    // A run file is shown in a sandbox: no script, no access to the console's cookie, never framed.
    expect(report.headers.get("content-security-policy")).toMatch(/^sandbox;.*frame-ancestors 'none'/);
    expect(await (await get(`${runPath}/plan/1`)).text()).toContain("TC-01");
    const headers = (await get("/")).headers;
    expect(headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(headers.get("x-frame-options")).toBe("DENY");
  }, 240_000);

  it("REQ-WEB-01/AC4: the printed address signs in one browser once; the cookie is a session of its own, for this console only", async () => {
    const { start, prefix, signin, setCookie, cookie } = await setup();
    expect(signin.status).toBe(303);
    expect(setCookie).toMatch(
      new RegExp(
        `^qj_console_${start.port}=[\\w-]+; HttpOnly; SameSite=Strict; Path=${prefix}/; Max-Age=43200$`,
      ),
    );
    // The session is not the token: the address in a history or a log signs nobody in.
    expect(cookie).not.toContain(TOKEN);
    expect((await fetch(start.href, { redirect: "manual" })).status).toBe(403);
    expect((await fetch(`${start.origin}${prefix}/`)).status).toBe(403);
    expect(
      (
        await fetch(`${start.origin}${prefix}/signin?token=${"é".repeat(TOKEN.length)}`, {
          redirect: "manual",
        })
      ).status,
    ).toBe(403);
    // Outside its random path nothing is there, signed in or not.
    expect((await fetch(`${start.origin}/p/demo`, { headers: { cookie } })).status).toBe(404);
    // DNS rebinding: a page of another site that resolves to 127.0.0.1 names its own host.
    expect(await raw(start.port, `${prefix}/`, { host: "evil.example", cookie })).toBe(421);
    // A change without the console's own Origin is refused before anything is read.
    expect(
      (await fetch(`${start.origin}${prefix}/p/demo`, { method: "POST", headers: { cookie } })).status,
    ).toBe(403);
  }, 240_000);

  it("REQ-WEB-01/AC4 + INV-8: only report/ and evidence/ are served; traversal, other folders and links out are not", async () => {
    const { get, p, start, prefix, cookie } = await setup();
    const base = `${prefix}${runPath}`;
    for (const path of [
      `${runPath}/files/journal/events.jsonl`,
      `${runPath}/files/env/secret.env`,
      `${runPath}/files/evidence/`,
      "/p/demo/t/DEMO-1/r/not-a-run",
      "/p/other",
    ])
      expect((await get(path)).status, path).toBe(404);
    // Sent as written: the server, not the client, must refuse these.
    for (const path of [
      `${base}/files/report/../run.json`,
      `${base}/files/report/%2e%2e/run.json`,
      `${base}/files/report/..%2Frun.json`,
      `${base}/files/report/..%5Crun.json`,
      `${base}/files/evidence/%2e%2e%2f%2e%2e%2fjournal/events.jsonl`,
    ])
      expect(await raw(start.port, path, { host: `127.0.0.1:${start.port}`, cookie }), path).toBe(404);
    // A link inside evidence/ pointing out of the run is not followed.
    const outside = await mkdtemp(join(tmpdir(), "qj-console-outside-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, "secret.txt"), "fictional secret");
    await symlink(join(outside, "secret.txt"), join(p.runDir, "evidence", "leak.txt"));
    expect((await get(`${runPath}/files/evidence/leak.txt`)).status).toBe(404);
    // A report/ folder that is itself a link is not served at all.
    await rename(join(p.runDir, "report"), join(p.runDir, "report-real"));
    await mkdir(join(outside, "report"));
    await writeFile(join(outside, "report", "id_ed25519"), "fictional key");
    await symlink(join(outside, "report"), join(p.runDir, "report"));
    expect((await get(`${runPath}/files/report/id_ed25519`)).status).toBe(404);
  }, 240_000);

  it("REQ-WEB-01: text from tickets and plans is escaped, never markup", async () => {
    const { get, p } = await setup();
    await writeFile(
      join(p.runDir, "plan", "plan.v1.md"),
      '<script>alert(1)</script> & <img src=x onerror=alert(1)> href="/x"',
    );
    const html = await (await get(`${runPath}/plan/1`)).text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img");
    // Escaped text never becomes a link of the console either.
    expect(html).toContain("href=&quot;/x&quot;");
  }, 240_000);
});
