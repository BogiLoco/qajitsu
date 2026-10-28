import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, DEMO_PASSWORD } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** Files under a folder whose bytes contain the text. */
const filesContaining = async (dir: string, text: string): Promise<string[]> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const hits: string[] = [];
  for (const e of entries.filter((x) => x.isFile())) {
    const path = join(e.parentPath, e.name);
    if ((await readFile(path)).includes(text)) hits.push(path);
  }
  return hits;
};

const statuses = async (dir: string) =>
  (JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as { data: { results: Record<string, string> } })
    .data.results;

/** fetch → plan → approve → run through the qj program, clean and with the ticket's seeded bug. */
const both = async (ticket: string, flag: string, extra: { cookieSession?: boolean } = {}) => {
  const clean = await createDemoPipeline({ ticket, withShopCode: true, ...extra });
  cleanups.push(clean.cleanup);
  const ok = await clean.executed();
  const bug = await createDemoPipeline({ ticket, flag, withShopCode: true, ...extra });
  cleanups.push(bug.cleanup);
  const failed = await bug.executed();
  return { ok, okDir: clean.runDir, failed, bugDir: bug.runDir };
};

describe("the whole qj flow on the new web capabilities", () => {
  it("REQ-EXEC-65 + REQ-NFR-04/AC1: DEMO-11 (installable, offline) passes; BUG-16 is FAILED", async () => {
    const r = await both("DEMO-11", "BUG_OFFLINE_NOTES_LOST");
    expect(r.ok.exitCode).toBe(0);
    expect(await statuses(r.okDir)).toEqual({ "TC-01": "PASSED", "TC-02": "PASSED" });
    expect(r.failed.exitCode).toBe(1);
    expect(await statuses(r.bugDir)).toEqual({ "TC-01": "PASSED", "TC-02": "FAILED" });
  }, 240_000);

  it("REQ-EXEC-47/AC3 + REQ-NFR-04/AC1: DEMO-12 (WebSocket chat) passes; BUG-17 is FAILED", async () => {
    const r = await both("DEMO-12", "BUG_CHAT_REPLY_DROPS_TEXT");
    expect(r.ok.exitCode).toBe(0);
    expect(await statuses(r.okDir)).toEqual({ "TC-01": "PASSED" });
    expect(await statuses(r.bugDir)).toEqual({ "TC-01": "FAILED" });
  }, 240_000);

  it("REQ-EXEC-67 + REQ-NFR-04/AC1: DEMO-13 (cookie session, sign-in form) passes; BUG-18 is FAILED; no password anywhere", async () => {
    const r = await both("DEMO-13", "BUG_SIGNIN_ANY_PASSWORD", { cookieSession: true });
    expect(r.ok.exitCode).toBe(0);
    expect(await statuses(r.okDir)).toEqual({ "TC-01": "PASSED", "TC-02": "PASSED", "TC-03": "PASSED" });
    expect(await statuses(r.bugDir)).toEqual({ "TC-01": "PASSED", "TC-02": "FAILED", "TC-03": "PASSED" });
    // What the run recorded (results, evidence, journal, report) never holds the account's password; the worktree
    // of the code under test (repos/) is the application's own source.
    for (const dir of [r.okDir, r.bugDir])
      expect(
        (await filesContaining(dir, DEMO_PASSWORD)).filter((f) => !f.startsWith(join(dir, "repos"))),
      ).toEqual([]);
  }, 240_000);
});
