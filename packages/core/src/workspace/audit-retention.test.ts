import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUDIT_DIR, pruneAuditArchive } from "./maintenance.js";

describe("audit archive retention (REQ-OBS-05/AC2)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qj-audit-"));
    await mkdir(join(root, AUDIT_DIR, "DEMO-1"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const journal = async (name: string, lastTs: string | undefined): Promise<string> => {
    const path = join(root, AUDIT_DIR, "DEMO-1", `${name}.events.jsonl`);
    await writeFile(
      path,
      lastTs === undefined
        ? "not json\n"
        : `${JSON.stringify({ ts: "2026-09-01T00:00:00.000Z", event: "a" })}\n${JSON.stringify({ ts: lastTs, event: "b" })}\n`,
    );
    return path;
  };

  it("REQ-OBS-05/AC2: retention counts from the journal's last entry, not from when the file was written", async () => {
    const old = await journal("20261001-1000-aaaa", "2026-10-02T10:00:00.000Z");
    const recent = await journal("20261120-1000-bbbb", "2026-11-20T10:00:00.000Z");
    // Both files were written just now: the file time says nothing about the run.
    const removed = await pruneAuditArchive(root, 30, new Date("2026-11-30T00:00:00.000Z"));
    expect(removed).toEqual([old]);
    expect(removed).not.toContain(recent);
  });

  it("REQ-OBS-05/AC2: a journal whose entries cannot be read falls back to the file's time", async () => {
    const unreadable = await journal("20261001-1000-cccc", undefined);
    expect(await pruneAuditArchive(root, 30, new Date("2026-11-30T00:00:00.000Z"))).toEqual([]);
    await utimes(unreadable, new Date("2026-09-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"));
    expect(await pruneAuditArchive(root, 30, new Date("2026-11-30T00:00:00.000Z"))).toEqual([unreadable]);
  });
});
