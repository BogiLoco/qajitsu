import { mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TicketKeySchema } from "../identifiers.js";
import {
  RUN_SUBDIRS,
  createRunWorkspace,
  openRunWorkspace,
  readRunIndex,
  resolveWorkspaceRoot,
} from "./run-workspace.js";

const ticket = TicketKeySchema.parse("DEMO-1");
const fixedNow = (): Date => new Date("2026-10-03T10:46:00Z");
const fixedRandom = (): number => 0;

describe("run workspace", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qj-ws-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("REQ-WS-01/AC1: creates <root>/<TICKET>/<RUN-ID>/ with a UTC time based run id", async () => {
    const ws = await createRunWorkspace({ root, ticket, now: fixedNow, random: fixedRandom });
    expect(ws.runId).toBe("20261003-1046-aaaa");
    expect(ws.dir).toBe(join(root, "DEMO-1", "20261003-1046-aaaa"));
    expect((await stat(ws.dir)).isDirectory()).toBe(true);
  });

  it("REQ-WS-01/AC2: creates every subfolder and run.json", async () => {
    const ws = await createRunWorkspace({ root, ticket, now: fixedNow, random: fixedRandom });
    for (const sub of RUN_SUBDIRS) {
      expect((await stat(join(ws.dir, sub))).isDirectory()).toBe(true);
    }
    const run = JSON.parse(await readFile(join(ws.dir, "run.json"), "utf8")) as Record<string, unknown>;
    expect(run).toMatchObject({
      schema: 1,
      ticket: "DEMO-1",
      runId: "20261003-1046-aaaa",
      status: "created",
      createdAt: "2026-10-03T10:46:00.000Z",
    });
  });

  it("REQ-WS-01/AC3: index.json lists runs with status and retention; latest points to the newest", async () => {
    let tick = 0;
    const now = (): Date => new Date(Date.UTC(2026, 9, 3, 10, 46 + tick));
    const first = await createRunWorkspace({ root, ticket, now, random: fixedRandom });
    tick = 1;
    const second = await createRunWorkspace({ root, ticket, now, random: () => 0.99 });
    await second.update({ status: "completed" });

    const index = await readRunIndex(root, ticket);
    expect(index.latest).toBe(second.runId);
    expect(index.runs.map((r) => [r.runId, r.status, r.retention])).toEqual([
      [first.runId, "created", "default"],
      [second.runId, "completed", "default"],
    ]);
    expect(await readlink(join(root, "DEMO-1", "latest"))).toBe(second.runId);
  });

  it("REQ-WS-01/AC1: retries with a new suffix when the run id already exists", async () => {
    const values = [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5];
    const random = (): number => values.shift() ?? 0.5;
    const a = await createRunWorkspace({ root, ticket, now: fixedNow, random });
    const b = await createRunWorkspace({ root, ticket, now: fixedNow, random });
    expect(a.runId).not.toBe(b.runId);
  });

  it("REQ-WS-01/AC2: update() merges into run.json and keeps it valid", async () => {
    const ws = await createRunWorkspace({ root, ticket, now: fixedNow, random: fixedRandom });
    await ws.update({
      stage: "fetch",
      repos: { app: { host: "github", path: "demo-org/demo-shop", sha: "a".repeat(40) } },
    });
    const reopened = await openRunWorkspace(root, ticket, ws.runId);
    expect(reopened.record.stage).toBe("fetch");
    expect(reopened.record.repos["app"]?.sha).toBe("a".repeat(40));
    expect(reopened.path("ticket", "ticket.json")).toBe(join(ws.dir, "ticket", "ticket.json"));
  });

  it("REQ-WS-01/AC2: rejects paths that escape the run folder", async () => {
    const ws = await createRunWorkspace({ root, ticket, now: fixedNow, random: fixedRandom });
    expect(() => ws.path("..", "..", "etc")).toThrow(/outside the run folder/);
  });

  it("REQ-WS-01: opening an unknown run is a configuration error", async () => {
    await expect(openRunWorkspace(root, ticket, "20261003-1046-zzzz")).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
    });
  });

  it("REQ-WS-01/AC4: the root defaults to the home directory, never the project repository", () => {
    expect(resolveWorkspaceRoot({ home: "/home/qa", cwd: "/repo" })).toBe(join("/home/qa", ".qa-runs"));
    expect(resolveWorkspaceRoot({ configured: "runs", home: "/home/qa", cwd: "/repo" })).toBe(
      join("/repo", "runs"),
    );
    expect(resolveWorkspaceRoot({ configured: "~/qa", home: "/home/qa", cwd: "/repo" })).toBe(
      join("/home/qa", "qa"),
    );
    expect(resolveWorkspaceRoot({ configured: "/abs", home: "/home/qa", cwd: "/repo" })).toBe("/abs");
  });
});
