import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readManifest } from "@qajitsu/adapter-evidence-local";
import { CaseResultFileSchema, ConfigError, QajitsuError, sha256, type CaseResultFile } from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";

/** A screenshot of a run that can become a baseline. */
interface Candidate {
  readonly caseId: string;
  readonly key: string;
  /** Evidence path of the screenshot. */
  readonly evidence: string;
  readonly reason: "no baseline" | "differs from the baseline";
}

const KEY = /^TC-\d{2,4}\/S\d{1,3}-[a-z0-9][a-z0-9-]{0,40}\.[a-z0-9.-]{1,80}$/;

/** Every results file of a run: primary, browser combinations and locales. */
async function allResults(session: RunSession): Promise<CaseResultFile[]> {
  const out: CaseResultFile[] = [];
  const read = async (dir: string): Promise<void> => {
    for (const file of (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"))) {
      const parsed = CaseResultFileSchema.safeParse(
        JSON.parse(await readFile(join(dir, file), "utf8")) as unknown,
      );
      if (parsed.success) out.push(parsed.data);
    }
  };
  await read(session.ws.path("results"));
  for (const group of ["matrix", "locale"])
    for (const name of await readdir(session.ws.path("results", group)).catch(() => [] as string[]))
      await read(session.ws.path("results", group, name));
  return out;
}

/**
 * `qajitsu baseline accept <TICKET>`: makes screenshots of a run the approved baselines in `.qa/baselines/`
 * (REQ-EXEC-12/AC3+AC4). By default only screenshots without a baseline (NEEDS_REVIEW); with `--include-failed`
 * also those that differ (an intended design change). Every screenshot is checked against its SHA-256 in the
 * evidence manifest before it is copied. This is a person's command: agents and the healer have no tool that
 * writes `.qa/`, and the run never updates a baseline.
 *
 * @returns 0 accepted (or nothing to accept), 2 not confirmed, 3 errors.
 */
export async function runBaselineAccept(
  rawKey: string,
  options: {
    readonly run?: string | undefined;
    readonly cases?: string | undefined;
    readonly includeFailed?: boolean | undefined;
    readonly yes?: boolean | undefined;
  },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
  user: string,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const wanted = options.cases
      ?.split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    const candidates: Candidate[] = [];
    for (const result of await allResults(session)) {
      if (wanted && !wanted.includes(result.caseId)) continue;
      const last = result.attempts.at(-1);
      for (const a of last?.assertions ?? []) {
        if (a.field !== "visual") continue;
        const missing = a.review === true;
        if (!missing && (a.pass || options.includeFailed !== true)) continue;
        const key = (a.expected as { baseline?: unknown } | undefined)?.baseline;
        const evidence = last?.evidence.find((e) => e.endsWith(`/${a.stepId}-visual-actual.png`));
        if (typeof key !== "string" || !KEY.test(key) || evidence === undefined) continue;
        candidates.push({
          caseId: result.caseId,
          key,
          evidence,
          reason: missing ? "no baseline" : "differs from the baseline",
        });
      }
    }
    if (candidates.length === 0) {
      io.write(
        options.includeFailed === true
          ? "No screenshot to accept in this run.\n"
          : "No screenshot without a baseline in this run; add --include-failed to accept changed screenshots.\n",
      );
      return 0;
    }
    // Only evidence that is intact (same SHA-256 as when the runner stored it) can become a baseline.
    const manifest = new Map(
      (await readManifest(session.ws.path("evidence"))).map((e) => [e.path, e.sha256]),
    );
    for (const c of candidates) {
      const bytes = await readFile(session.ws.path("evidence", c.evidence)).catch(() => undefined);
      if (!bytes || manifest.get(c.evidence) !== sha256(bytes))
        throw new ConfigError(
          "BASELINE_EVIDENCE_CHANGED",
          `${c.evidence} is missing or does not match the evidence manifest; nothing was accepted.`,
          {},
        );
    }
    const target = join(session.project.qaDir, "baselines");
    io.write(
      [
        `Baselines to accept into ${target}:`,
        ...candidates.map((c) => `  ${c.key}.png  (${c.caseId}, ${c.reason})`),
        "",
      ].join("\n"),
    );
    if (options.yes !== true) {
      const answer = io.ask ? (await io.ask("Accept these screenshots as baselines? [y/N] ")).trim() : "";
      if (!/^y(es)?$/i.test(answer)) {
        io.writeError(
          io.ask ? "Nothing accepted.\n" : "Not interactive: nothing accepted; confirm with --yes.\n",
        );
        return 2;
      }
    }
    for (const c of candidates) {
      const file = join(target, `${c.key}.png`);
      await mkdir(dirname(file), { recursive: true });
      await copyFile(session.ws.path("evidence", c.evidence), file);
    }
    session.events.emit("run", { kind: "user", name: user }, "baseline.accepted", {
      keys: candidates.map((c) => c.key),
    });
    io.write(
      `Accepted ${String(candidates.length)} baseline(s). Commit .qa/baselines/ so the team and CI use them.\n`,
    );
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
