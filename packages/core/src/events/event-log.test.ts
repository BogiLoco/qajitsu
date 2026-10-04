import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENESIS_HASH,
  checkJournal,
  createEventLog,
  fileSink,
  journalAnchor,
  journalTailHash,
  parseEventLines,
  verifyEventChain,
} from "./event-log.js";

const now = (): Date => new Date("2026-10-03T10:46:00Z");

describe("event log (REQ-OBS-01)", () => {
  it("REQ-OBS-01/AC2: every event has ISO time, run, ticket, stage, actor and masked details", () => {
    const lines: string[] = [];
    const log = createEventLog({
      ticket: "DEMO-1",
      run: "20261003-1046-aaaa",
      write: (l) => lines.push(l),
      now,
      mask: (v) => JSON.parse(JSON.stringify(v).replaceAll("s3cr3t-value", "***")) as unknown,
    });
    log.emit("fetch", { kind: "system", name: "orchestrator" }, "stage.start");
    log.emit("plan", { kind: "user", name: "qa" }, "plan.approved", { note: "token s3cr3t-value" });
    expect(lines.join("")).not.toContain("s3cr3t-value");
    const { events, invalidLines } = parseEventLines(lines.join(""));
    expect(invalidLines).toEqual([]);
    expect(events).toEqual([
      {
        ts: "2026-10-03T10:46:00.000Z",
        run: "20261003-1046-aaaa",
        ticket: "DEMO-1",
        stage: "fetch",
        actor: { kind: "system", name: "orchestrator" },
        event: "stage.start",
      },
      {
        ts: "2026-10-03T10:46:00.000Z",
        run: "20261003-1046-aaaa",
        ticket: "DEMO-1",
        stage: "plan",
        actor: { kind: "user", name: "qa" },
        event: "plan.approved",
        details: { note: "token ***" },
      },
    ]);
  });

  it("REQ-OBS-01/AC1: appends to journal/events.jsonl in emit order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qj-ev-"));
    try {
      const file = join(dir, "events.jsonl");
      const log = createEventLog({ ticket: "DEMO-1", run: "r", write: fileSink(file), now, mask: (v) => v });
      for (const e of ["stage.start", "ticket.fetched", "stage.end"]) {
        log.emit("fetch", { kind: "system", name: "orchestrator" }, e);
      }
      const { events } = parseEventLines(await readFile(file, "utf8"));
      expect(events.map((e) => e.event)).toEqual(["stage.start", "ticket.fetched", "stage.end"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed event names and reports invalid lines", () => {
    const log = createEventLog({ ticket: "T-1", run: "r", write: () => undefined, now, mask: (v) => v });
    expect(() => {
      log.emit("x", { kind: "system", name: "o" }, "Bad Name");
    }).toThrow();
    expect(parseEventLines('not json\n{"ts":1}\n').invalidLines).toEqual([1, 2]);
  });
});

describe("hash chain (REQ-OBS-05)", () => {
  it("REQ-OBS-05/AC1: lines chain across processes; edits, deletions and insertions break the chain", async () => {
    const { writeFile } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "qj-chain-"));
    try {
      const file = join(dir, "events.jsonl");
      const log = (n: number) =>
        createEventLog({
          ticket: "DEMO-1",
          run: "r",
          write: fileSink(file),
          now: () => new Date(n),
          mask: (v) => v,
          previousHash: journalTailHash(file),
        });
      expect(journalTailHash(file)).toBe(GENESIS_HASH);
      const first = log(0);
      first.emit("fetch", { kind: "system", name: "o" }, "stage.start");
      first.emit("fetch", { kind: "system", name: "o" }, "stage.end", { ok: true });
      // A second process continues the same chain.
      log(1).emit("plan", { kind: "agent", name: "planner" }, "stage.start");
      const text = await readFile(file, "utf8");
      expect(verifyEventChain(text)).toEqual([]);
      const lines = text.trim().split("\n");
      expect((JSON.parse(lines[0] ?? "") as { prev: string }).prev).toBe(GENESIS_HASH);
      expect(
        verifyEventChain(
          lines.map((l, i) => (i === 1 ? l.replace('"ok":true', '"ok":false') : l)).join("\n"),
        ),
      ).toEqual([{ line: 3, reason: "does not match the previous line" }]);
      expect(verifyEventChain([lines[0], lines[2]].join("\n"))).toEqual([
        { line: 2, reason: "does not match the previous line" },
      ]);
      expect(verifyEventChain(`${lines.join("\n")}\n{"ts":"x"}\nnot json`)).toEqual([
        { line: 4, reason: "no hash of the previous line" },
        { line: 5, reason: "not valid JSON" },
      ]);
      await writeFile(file, "\n");
      expect(journalTailHash(file)).toBe(GENESIS_HASH);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("journal checks (REQ-OBS-05, stage-9 review)", () => {
  it("missing or cut journals fail; legacy journals pass; concurrent writers keep one chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qj-chain2-"));
    try {
      const file = join(dir, "events.jsonl");
      const writer = () =>
        createEventLog({
          ticket: "DEMO-1",
          run: "r",
          write: fileSink(file),
          now: () => new Date(0),
          mask: (v) => v,
          tail: () => journalTailHash(file),
        });
      const a = writer();
      const b = writer();
      a.emit("run", { kind: "system", name: "o" }, "stage.start");
      b.emit("publish", { kind: "user", name: "u" }, "publish.preview");
      a.emit("run", { kind: "system", name: "o" }, "stage.end");
      const text = await readFile(file, "utf8");
      expect(verifyEventChain(text)).toEqual([]);
      const anchor = journalAnchor(text);
      expect(anchor.lines).toBe(3);
      expect(checkJournal(text, anchor)).toEqual({ problems: [], legacy: false });
      const cut = text.trim().split("\n").slice(0, 2).join("\n");
      expect(checkJournal(cut, anchor).problems).toEqual(["journal has 2 lines, 3 were recorded"]);
      expect(checkJournal("", anchor).problems).toEqual(["journal is missing or empty"]);
      const rewritten = text.replace('"stage.end"', '"stage.end2"');
      expect(checkJournal(rewritten, anchor).problems).toContain("line 3 differs from the recorded anchor");
      expect(checkJournal('{"ts":"x","event":"old"}\n')).toEqual({ problems: [], legacy: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
