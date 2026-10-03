import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventLog, fileSink, parseEventLines } from "./event-log.js";

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
