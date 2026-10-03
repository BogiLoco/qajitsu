import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TicketKeySchema } from "../identifiers.js";
import { acquireRunLock, processAlive, withFileLock } from "./locks.js";
import { cleanRunFiles, deleteRun, expiredRuns, listTickets } from "./maintenance.js";
import { RunIndexSchema, createRunWorkspace, readRunIndex } from "./run-workspace.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "qj-maint-"));
  dirs.push(d);
  return d;
};
const ticket = TicketKeySchema.parse("DEMO-1");
let n = 0;
const random = () => ((n += 1) % 997) / 997;

describe("run locks (REQ-WS-04/AC2)", () => {
  it("REQ-WS-04/AC2: a live holder blocks the run; a dead holder's lock is taken over", async () => {
    const dir = await tmp();
    const lock = join(dir, "run.lock");
    const release = await acquireRunLock(lock, 111, () => true);
    await expect(acquireRunLock(lock, 222, () => true)).rejects.toMatchObject({ code: "RUN_LOCKED" });
    const taken = await acquireRunLock(lock, 222, () => false);
    await taken();
    await release();
    expect(await readdir(dir)).toEqual([]);
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 12345)).toBe(false);
  });

  it("REQ-WS-04/AC2: parallel runs of one ticket keep every index entry", async () => {
    const root = await tmp();
    const runs = await Promise.all(
      Array.from({ length: 8 }, () => createRunWorkspace({ root, ticket, now: () => new Date(), random })),
    );
    await Promise.all(runs.map((ws) => ws.update({ status: "running" })));
    const index = await readRunIndex(root, ticket);
    expect(index.runs.map((r) => r.runId).sort()).toEqual(runs.map((r) => r.runId).sort());
    expect(index.runs.every((r) => r.status === "running")).toBe(true);
  });

  it("withFileLock serialises work, takes over stale locks and times out", async () => {
    const dir = await tmp();
    const lock = join(dir, "x.lock");
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((i) =>
        withFileLock(lock, async () => {
          order.push(i);
          await new Promise((r) => setTimeout(r, 5));
          order.push(-i);
        }),
      ),
    );
    for (let i = 0; i < order.length; i += 2) expect(order[i + 1]).toBe(-(order[i] ?? 0));
    await writeFile(lock, "");
    await expect(withFileLock(lock, () => Promise.resolve(1), { timeoutMs: 50 })).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
    });
    expect(await withFileLock(lock, () => Promise.resolve(2), { staleMs: -1 })).toBe(2);
  });
});

describe("cleanup and retention (REQ-WS-03)", () => {
  it("REQ-WS-03/AC3 + AC4 + REQ-CFG-05/AC2: removes worktrees and env files only; symlinks are not followed", async () => {
    const root = await tmp();
    const outside = await tmp();
    await writeFile(join(outside, "precious.txt"), "keep me");
    const ws = await createRunWorkspace({ root, ticket, now: () => new Date(), random });
    await mkdir(ws.path("repos", "shop"), { recursive: true });
    await writeFile(ws.path("repos", "shop", "a.ts"), "x");
    await writeFile(ws.path("repos", "shop.diff"), "diff");
    await symlink(outside, ws.path("repos", "evil"));
    await writeFile(ws.path("env", "api.env"), "A=1");
    await writeFile(ws.path("results", "TC-01.json"), "{}");
    expect((await cleanRunFiles(ws)).sort()).toEqual(["env/api.env", "repos/evil", "repos/shop"]);
    expect(await readdir(ws.path("repos"))).toEqual(["shop.diff"]);
    expect(await readdir(ws.path("results"))).toEqual(["TC-01.json"]);
    expect(await readdir(outside)).toEqual(["precious.txt"]);
  });

  it("REQ-WS-03/AC2: keep_last and max_age_days select runs; keep and running runs are exempt", () => {
    const at = (d: string) => `2026-${d}T10:00:00.000Z`;
    const index = RunIndexSchema.parse({
      ticket: "DEMO-1",
      runs: [
        { runId: "20260101-1000-aaaa", createdAt: at("01-01"), status: "completed", retention: "keep" },
        { runId: "20260901-1000-bbbb", createdAt: at("09-01"), status: "completed", retention: "default" },
        { runId: "20260920-1000-cccc", createdAt: at("09-20"), status: "failed", retention: "default" },
        { runId: "20261001-1000-dddd", createdAt: at("10-01"), status: "running", retention: "default" },
        { runId: "20261002-1000-eeee", createdAt: at("10-02"), status: "completed", retention: "default" },
      ],
    });
    const now = new Date(at("10-03"));
    expect(expiredRuns(index, { keep_last: 10, max_age_days: 30 }, now)).toEqual(["20260901-1000-bbbb"]);
    expect(expiredRuns(index, { keep_last: 1, max_age_days: 365 }, now)).toEqual([
      "20260920-1000-cccc",
      "20260901-1000-bbbb",
    ]);
  });

  it("REQ-WS-04/AC1: deleteRun removes the folder and index entry and moves latest", async () => {
    const root = await tmp();
    const a = await createRunWorkspace({ root, ticket, now: () => new Date("2026-10-01T00:00:00Z"), random });
    const b = await createRunWorkspace({ root, ticket, now: () => new Date("2026-10-02T00:00:00Z"), random });
    await deleteRun(root, ticket, b.runId);
    expect(await readRunIndex(root, ticket)).toMatchObject({ latest: a.runId, runs: [{ runId: a.runId }] });
    await deleteRun(root, ticket, a.runId);
    expect((await readRunIndex(root, ticket)).latest).toBeUndefined();
    expect(await listTickets(root)).toEqual([]);
    await createRunWorkspace({ root, ticket, now: () => new Date(), random });
    await mkdir(join(root, "not-a-ticket"));
    expect(await listTickets(root)).toEqual(["DEMO-1"]);
    await expect(deleteRun(root, ticket, "../x")).rejects.toThrow();
  });
});
