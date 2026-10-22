import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { AGENT_TRANSCRIPT_FILE, ConfigError, QajitsuError, sha256 } from "@qajitsu/core";
import { zip } from "@qajitsu/report";
import { createMasker } from "@qajitsu/steps";
import { buildAuditTrail, type AuditTrail } from "@qajitsu/verifier";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";

/** Where the trail of a run is written, inside the run folder. */
export const TRAIL_FILE = "audit/trail.json";

/**
 * Folders that are not part of the trail: `env/` holds 0600 env files with secrets, `audit/` is the trail itself.
 * Under `repos/` only the change records are kept (diff, change and metadata files), never checked-out code.
 */
const SKIP_TOP = new Set(["env", "audit"]);

const walk = async (dir: string, root: string, out: string[]): Promise<void> => {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, name);
    const rel = relative(root, path).split("\\").join("/");
    const [top] = rel.split("/");
    if (top !== undefined && SKIP_TOP.has(top)) continue;
    if (name.endsWith(".lock") || name === "node_modules") continue;
    const info = await lstat(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      // Under repos/ only the change records count; checked-out code (repos/<alias>/) is not part of the trail.
      if (top === "repos" && rel !== "repos") continue;
      await walk(path, root, out);
    } else if (info.isFile()) out.push(rel);
  }
};

/** The trail of a run and what it was computed from. */
export interface LoadedTrail {
  readonly trail: AuditTrail;
  /** Run-relative path → content, for the export. */
  readonly read: (path: string) => Promise<Uint8Array>;
  readonly record: Record<string, unknown>;
}

/**
 * Reads a run folder and computes its audit trail (REQ-VER-16/AC1+AC4): every file with its SHA-256 and every gap.
 *
 * @param session - The run.
 */
export async function loadAuditTrail(session: Pick<RunSession, "ws">): Promise<LoadedTrail> {
  const { ws } = session;
  const paths: string[] = [];
  await walk(ws.dir, ws.dir, paths);
  const files = new Map<string, string>();
  for (const p of paths) files.set(p, sha256(new Uint8Array(await readFile(join(ws.dir, p)))));
  const text = (p: string): Promise<string | undefined> =>
    readFile(join(ws.dir, p), "utf8").catch(() => undefined);
  const manifestText = await text("evidence/manifest.json");
  let manifest: { path: string; sha256: string }[] | undefined;
  try {
    const parsed = JSON.parse(manifestText ?? "") as unknown;
    if (Array.isArray(parsed)) manifest = parsed as { path: string; sha256: string }[];
  } catch {
    manifest = undefined;
  }
  const results: { caseId: string; spec?: string }[] = [];
  for (const p of paths.filter((x) => /^results\/[^/]+\.json$/.test(x))) {
    try {
      const r = JSON.parse((await text(p)) ?? "") as { caseId?: unknown; spec?: unknown };
      if (typeof r.caseId === "string")
        results.push({ caseId: r.caseId, ...(typeof r.spec === "string" ? { spec: r.spec } : {}) });
    } catch {
      // An unreadable result shows up as a gap of its case's spec only if the case had one.
    }
  }
  const trail = buildAuditTrail({
    files,
    repos: ws.record.repos as Record<string, { sha?: string; change?: string }>,
    data: ws.record.data,
    events: await text("journal/events.jsonl"),
    transcript: await text(AGENT_TRANSCRIPT_FILE),
    manifest,
    results,
  });
  return {
    trail,
    read: async (p) => new Uint8Array(await readFile(join(ws.dir, p))),
    record: { ticket: ws.ticket, runId: ws.runId, repos: ws.record.repos, data: ws.record.data },
  };
}

/** The `audit/trail.json` document: the trail plus the records that are not files. */
const trailDocument = (loaded: LoadedTrail, now: Date): Record<string, unknown> => {
  const data = (loaded.record["data"] ?? {}) as Record<string, unknown>;
  const build = (data["build"] ?? {}) as Record<string, unknown>;
  return {
    schema: 1,
    ticket: loaded.record["ticket"],
    runId: loaded.record["runId"],
    at: now.toISOString(),
    complete: loaded.trail.gaps.length === 0,
    gaps: loaded.trail.gaps,
    records: {
      repos: loaded.record["repos"],
      approval: data["approval"],
      approvals: data["approvals"] ?? [],
      versions: data["versions"],
      images: build["images"] ?? [],
      environment: data["environment"],
      codeAccess: data["codeAccess"],
    },
    files: loaded.trail.items,
  };
};

const summary = (trail: AuditTrail): string => {
  const counts = new Map<string, number>();
  for (const i of trail.items) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
  return [...counts.entries()].map(([c, n]) => `${c} ${String(n)}`).join(", ");
};

const reportGaps = (io: CommandIO, trail: AuditTrail): void => {
  if (trail.gaps.length === 0) io.write("✔ The audit trail is complete.\n");
  else
    io.write(
      `✘ The audit trail has ${String(trail.gaps.length)} gap(s); no certificate can be issued until they are fixed:\n${trail.gaps.map((g) => `  - ${g}`).join("\n")}\n`,
    );
};

/**
 * `qajitsu audit trail <TICKET> [--run <id>]`: lists the run's audit trail and its gaps, and writes
 * `audit/trail.json` (REQ-VER-16/AC1+AC4).
 *
 * @returns 0 for a complete trail, 1 when it has gaps, 3 on errors.
 */
export async function runAuditTrail(
  rawKey: string,
  options: { readonly run?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const loaded = await loadAuditTrail(session);
    await mkdir(session.ws.path("audit"), { recursive: true });
    await writeFile(
      session.ws.path(...(TRAIL_FILE.split("/") as [string, string])),
      `${JSON.stringify(trailDocument(loaded, ports.now()), null, 2)}\n`,
    );
    io.write(
      `Audit trail of ${session.ws.ticket} (run ${session.ws.runId}): ${String(loaded.trail.items.length)} files (${summary(loaded.trail)})\n`,
    );
    reportGaps(io, loaded.trail);
    io.write(`Written to ${session.ws.path("audit", "trail.json")}\n`);
    return loaded.trail.gaps.length === 0 ? 0 : 1;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}

/** Playwright traces stay local: they hold network headers inside compressed data the secret scan cannot read. */
const exportable = (path: string, manifestKinds: ReadonlyMap<string, string>): boolean =>
  manifestKinds.get(path) !== "trace";

const README = (doc: Record<string, unknown>, left: readonly string[]): string =>
  [
    `QAJitsu audit trail of ${String(doc["ticket"])}, run ${String(doc["runId"])}`,
    "",
    "Everything that influenced the verdict of this run, with the SHA-256 of every file.",
    "Secrets were masked before the files were written and hashed.",
    "",
    "Check the files without QAJitsu:",
    "  sha256sum -c SHA256SUMS        (Linux)",
    "  shasum -a 256 -c SHA256SUMS    (macOS)",
    "",
    "Contents:",
    "  audit/trail.json        every file with its category and SHA-256, the gaps, approvals, versions,",
    "                          container image digests and the tested environment",
    "  run.json                the run record",
    "  ticket/                 the ticket as fetched at the start",
    "  repos/                  commit and change records, the diff",
    "  plan/                   every plan version and the approved, frozen plan",
    "  specs/                  the generated tests that ran",
    "  results/, logs/         raw runner output",
    "  evidence/               evidence and its manifest with SHA-256",
    "  checks/                 auditor and canary records",
    "  report/                 matrix, report.html, junit.xml, published comments",
    "  journal/events.jsonl    the event journal; each line holds the SHA-256 of the line before it",
    "  journal/agents.jsonl    every model call: prompt, answer, tool calls and results, model, tokens;",
    "                          the journal's model.usage events hold the SHA-256 of each line",
    "",
    doc["complete"] === true
      ? "The trail was complete when it was exported."
      : `The trail was NOT complete when it was exported:\n${(doc["gaps"] as string[]).map((g) => `  - ${g}`).join("\n")}`,
    ...(left.length > 0
      ? [
          "",
          "Listed in audit/trail.json but not in this archive (Playwright traces hold network headers in compressed",
          "data the secret scan cannot read; they stay with the run):",
          ...left.map((p) => `  ${p}`),
        ]
      : []),
    "",
  ].join("\n");

/**
 * `qajitsu audit export <TICKET> [--run <id>] [--out <file>]`: the audit trail as one zip for an external auditor,
 * readable without QAJitsu (REQ-VER-16/AC5): the files, `audit/trail.json`, `SHA256SUMS` and a README. Every file is
 * secret-scanned first; a file with a secret value stops the export.
 *
 * @returns 0 when the archive was written from a complete trail, 1 when the trail has gaps, 3 on errors.
 */
export async function runAuditExport(
  rawKey: string,
  options: { readonly run?: string | undefined; readonly out?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const loaded = await loadAuditTrail(session);
    const doc = trailDocument(loaded, ports.now());
    const kinds = new Map<string, string>();
    try {
      const manifest = JSON.parse(new TextDecoder().decode(await loaded.read("evidence/manifest.json"))) as {
        path: string;
        kind?: string;
      }[];
      for (const m of manifest) kinds.set(`evidence/${m.path}`, m.kind ?? "");
    } catch {
      // A missing manifest is a gap of the trail already.
    }
    const included = loaded.trail.items.filter((i) => exportable(i.path, kinds));
    const left = loaded.trail.items.filter((i) => !exportable(i.path, kinds)).map((i) => i.path);
    const entries = await Promise.all(
      included.map(async (i) => ({ name: i.path, data: await loaded.read(i.path) })),
    );
    const leaking = entries
      .filter((e) => masker.containsSecret(Buffer.from(e.data).toString("utf8")))
      .map((e) => e.name);
    if (leaking.length > 0)
      throw new ConfigError(
        "SECRET_IN_EXPORT",
        `Secret scan failed: ${leaking.join(", ")} contain a secret value; nothing was exported.`,
        {},
      );
    const trailJson = new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`);
    const sums = [...included.map((i) => `${i.sha256}  ${i.path}`), `${sha256(trailJson)}  ${TRAIL_FILE}`];
    const data = zip([
      ...entries,
      { name: TRAIL_FILE, data: trailJson },
      { name: "SHA256SUMS", data: new TextEncoder().encode(`${sums.join("\n")}\n`) },
      { name: "README.txt", data: new TextEncoder().encode(README(doc, left)) },
    ]);
    const name = `${session.ws.ticket}_${session.ws.runId}_audit.zip`;
    const out =
      options.out !== undefined
        ? resolve(io.cwd, options.out)
        : join(session.project.project?.paths.exports ?? session.ws.path("report"), session.ws.ticket, name);
    await mkdir(resolve(out, ".."), { recursive: true });
    await writeFile(out, data);
    io.write(`Audit archive: ${out} (${String(entries.length)} files, ${String(data.byteLength)} bytes)\n`);
    reportGaps(io, loaded.trail);
    return loaded.trail.gaps.length === 0 ? 0 : 1;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
