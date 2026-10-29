import { readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import {
  createEventLog,
  fragment,
  parseEventLines,
  type ContextFragment,
  type RunWorkspace,
} from "@qajitsu/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedModel } from "../../../tests/support/mock-model.js";
import { createFetchedRun } from "../../../tests/support/run-fixture.js";
import { rebuildCall } from "./context-rebuild.js";
import { assembleFor, type AgentStageDeps } from "./roles-run.js";

const f = (over: Partial<Parameters<typeof fragment>[0]> & { text: string }): ContextFragment =>
  fragment({
    kind: "log",
    source: "x",
    trust: "untrusted",
    section: "varying",
    priority: 50,
    pinned: false,
    ...over,
  });

const log = Array.from({ length: 200 }, (_, i) =>
  i === 120 ? "Error: discount service timed out" : `line ${String(i)} ok`,
).join("\n");

const fragments = [
  f({
    kind: "role-instructions",
    source: "triage",
    trust: "trusted",
    section: "stable",
    priority: 100,
    pinned: true,
    text: "Suggest the cause.",
  }),
  f({ kind: "plan", source: "plan", priority: 80, pinned: true, text: "Case C01 checks the discount." }),
  f({ source: "logs/api.log", text: log }),
  f({ kind: "question", source: "question", trust: "trusted", priority: 0, pinned: true, text: "Answer." }),
];

describe("rebuilding a recorded call from its snapshot (REQ-CTX-17/AC4)", () => {
  let root: string;
  let ws: RunWorkspace;
  let lines: string[];
  beforeEach(async () => {
    ({ root, ws } = await createFetchedRun());
    lines = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const record = async () => {
    const events = createEventLog({
      ticket: "DEMO-1",
      run: ws.runId,
      write: (l) => lines.push(l),
      now: () => new Date(0),
      mask: (v) => v,
    });
    const m = scriptedModel([{ text: "{}" }]);
    // A 500-token budget: the 200-line log is trimmed to its error by code.
    const model = { ...m, context: { ...m.context, workingRange: 1_500, answerReserve: 1_000 } };
    const sent = await assembleFor({ ws, events } as unknown as AgentStageDeps, {
      stage: "triage",
      role: "triage",
      model,
      fragments,
    });
    const details = parseEventLines(lines.join("")).events.find(
      (e) => e.event === "context.snapshot",
    )?.details;
    const texts = new Map<string, string>();
    for (const name of await readdir(ws.path("context", "fragments")))
      texts.set(name.replace(/\.txt$/, ""), await readFile(ws.path("context", "fragments", name), "utf8"));
    return { sent, details, texts };
  };

  it("REQ-CTX-17/AC4: the input is rebuilt exactly, trimming applied again by code", async () => {
    const { sent, details, texts } = await record();
    expect(sent.snapshot.reductions.map((r) => r.action)).toEqual(["trimmed"]);
    const rebuilt = rebuildCall(details, (h) => texts.get(h));
    expect(rebuilt.snapshotIntact).toBe(true);
    expect(rebuilt.sameRenderer).toBe(true);
    expect(rebuilt.fragments.every((x) => x.status === "same")).toBe(true);
    expect(rebuilt.input?.system).toBe(sent.system);
    expect(rebuilt.input?.prompt).toBe(sent.prompt);
  });

  it("REQ-CTX-17/AC4: a changed or missing fragment and a tampered snapshot are reported by fragment", async () => {
    const { details, texts } = await record();
    const logSha = fragments[2]?.sha256 ?? "";
    await writeFile(ws.path("context", "fragments", `${logSha}.txt`), `${log}\nadded later`);
    const changed = rebuildCall(details, (h) => (h === logSha ? `${log}\nadded later` : texts.get(h)));
    expect(changed.fragments.filter((x) => x.status !== "same")).toEqual([
      { kind: "log", source: "logs/api.log", sha256: logSha, status: "changed" },
    ]);
    expect(changed.input).toBeUndefined();
    await unlink(ws.path("context", "fragments", `${logSha}.txt`));
    const missing = rebuildCall(details, (h) => (h === logSha ? undefined : texts.get(h)));
    expect(missing.fragments.find((x) => x.sha256 === logSha)?.status).toBe("missing");
    const tampered = rebuildCall({ ...(details as object), stage: "plan" }, (h) => texts.get(h));
    expect(tampered.snapshotIntact).toBe(false);
  });
});
