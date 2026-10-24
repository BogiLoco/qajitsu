import { createPublicKey, type KeyObject } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CERTIFICATE_FILE,
  ConfigError,
  QajitsuError,
  TicketKeySchema,
  approvePlan,
  createRunWorkspace,
  resolveWorkspaceRoot,
  type DsseEnvelope,
} from "@qajitsu/core";
import { diffVersions } from "@qajitsu/report";
import { createMasker } from "@qajitsu/steps";
import { checkCertificate } from "@qajitsu/verifier";
import type { RuntimePorts } from "../adapters.js";
import { loadProject } from "../project.js";
import { openSession, type ModelPorts } from "../session.js";
import { KEYS_DIR, openRunFiles, publicKeysIn } from "./certificate.js";
import { runFetch, type CommandIO } from "./fetch.js";
import { runRun, type RunPorts } from "./run.js";
import { computeVerdict } from "./verdict.js";

/** How a case of the reproduction compares with the certified run (REQ-VER-20/AC2). */
export type CaseComparison = "same" | "different" | "not reproducible";

/**
 * Compares the statuses of a reproduction with the certified ones (REQ-VER-20/AC2): the same status is `same`; a case
 * that could not run again (BLOCKED, NOT_RUN or missing) is `not reproducible`; any other change is `different`.
 *
 * @param certified - Statuses in the certificate.
 * @param now - Statuses of the reproduction.
 */
export function compareReproduction(
  certified: Readonly<Record<string, string>>,
  now: Readonly<Record<string, string>>,
): {
  readonly caseId: string;
  readonly before: string;
  readonly after: string;
  readonly result: CaseComparison;
}[] {
  return Object.entries(certified).map(([caseId, before]) => {
    const after = now[caseId] ?? "missing";
    const result: CaseComparison =
      after === before
        ? "same"
        : after === "BLOCKED" || after === "NOT_RUN" || after === "missing"
          ? "not reproducible"
          : "different";
    return { caseId, before, after, result };
  });
}

/**
 * `qajitsu reproduce <path> [--env <env> | --build] [--key <file>...]`: runs again exactly what a certified run ran
 * (REQ-VER-20): the certificate of the run folder or audit export is checked first; then a new run of the ticket gets
 * the certified ticket snapshot, the frozen plan (byte for byte, so its SHA-256 is the same) and the generated tests,
 * and runs them without any agent step, against the chosen environment or, with `--build`, the code at the certified
 * commits. The new run gets its own certificate; each case is compared (same, different, not reproducible), and tool
 * versions and image digests that differ are named. Nothing of the original run changes.
 *
 * @returns 0 every case the same, 1 a case differs, 2 a case could not be reproduced, 3 errors.
 */
export async function runReproduce(
  source: string,
  options: {
    readonly env?: string | undefined;
    readonly build?: boolean | undefined;
    readonly key?: readonly string[] | undefined;
    readonly user?: string | undefined;
  },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & RunPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const files = await openRunFiles(resolve(io.cwd, source));
    const raw = files.read(CERTIFICATE_FILE);
    if (raw === undefined)
      throw new ConfigError(
        "CERTIFICATE_NOT_FOUND",
        `No ${CERTIFICATE_FILE} in ${source}: only certified runs are reproduced.`,
        {},
      );
    const envelope = JSON.parse(new TextDecoder().decode(raw)) as DsseEnvelope;
    const project = await loadProject(io.cwd, ports.project);
    const keys: KeyObject[] = (await publicKeysIn(join(project.qaDir, KEYS_DIR))).map((k) => k.key);
    for (const k of options.key ?? []) keys.push(createPublicKey(await readFile(resolve(io.cwd, k), "utf8")));
    // AC1: only what was certified, unchanged, is run again.
    const check = checkCertificate(envelope, keys, files.read);
    const failures = [
      ...check.problems,
      ...check.changed.map((f) => `changed: ${f}`),
      ...check.missing.map((f) => `missing: ${f}`),
    ];
    if (failures.length > 0 || !check.statement)
      throw new ConfigError(
        "REPRODUCE_SOURCE_INVALID",
        `The certificate of ${source} does not verify: ${failures.join("; ")}`,
        {
          problems: failures,
        },
      );
    const p = check.statement.predicate;
    const ticket = TicketKeySchema.parse(p.ticket);
    const certifiedStatuses = p.statuses ?? {};
    const plan = check.statement.subject.find((s) => s.name === "plan/plan.approved.yaml");
    const approvedText = files.read("plan/plan.approved.yaml");
    if (!plan || !approvedText)
      throw new ConfigError("REPRODUCE_SOURCE_INVALID", "The certificate covers no approved plan.", {});
    const version = (p.plan as { version?: unknown } | undefined)?.version;
    if (typeof version !== "number")
      throw new ConfigError("REPRODUCE_SOURCE_INVALID", "The certificate names no plan version.", {});

    // The new run: with --build its code is checked out at the certified commits.
    const root = resolveWorkspaceRoot({
      configured: project.config.workspace.root,
      home: ports.home,
      cwd: project.qaDir,
    });
    let runId: string;
    if (options.build === true) {
      const refs = Object.entries((p.repos ?? {}) as Record<string, { sha?: string }>).flatMap(
        ([alias, r]) => (r.sha ? [`${alias}=${r.sha}`] : []),
      );
      const quiet = { ...io, write: () => undefined };
      if ((await runFetch(ticket, { ref: refs }, quiet, ports)) !== 0)
        throw new ConfigError(
          "REPRODUCE_FETCH_FAILED",
          `The code at ${refs.join(", ")} could not be fetched.`,
          {},
        );
      runId = (await openSession(ticket, undefined, io.cwd, ports, masker)).ws.runId;
    } else runId = (await createRunWorkspace({ root, ticket, now: ports.now, random: ports.random })).runId;
    const session = await openSession(ticket, runId, io.cwd, ports, masker);
    const { ws } = session;
    for (const name of ["ticket/ticket.json", "ticket/ticket.md"]) {
      const data = files.read(name);
      if (data) await writeFile(ws.path(...(name.split("/") as [string, string])), data);
    }
    await writeFile(ws.path("plan", `plan.v${String(version)}.yaml`), approvedText);
    await approvePlan(ws, {
      approver: `certificate ${check.id ?? ""} (approved by ${String((p.plan as { approver?: unknown }).approver)})`,
      now: ports.now,
      confirmOpenQuestions: true,
    });
    for (const s of check.statement.subject.filter((x) => /^specs\/[^/]+\.spec\.ts$/.test(x.name))) {
      const data = files.read(s.name);
      if (data) await writeFile(ws.path(...(s.name.split("/") as [string, string])), data);
    }
    const sourceRun = typeof p.runId === "string" ? p.runId : "";
    await ws.update({
      // The change under test is the certified one: its commits, also when the environment is provided (no --build).
      ...(options.build === true ? {} : { repos: (p.repos ?? {}) as typeof ws.record.repos }),
      data: {
        ...ws.record.data,
        ...(ports.project ? { project: ports.project.slug } : {}),
        // No agent step (AC1): the run is executed like a regression run of frozen specs.
        regression: { pack: `certificate ${check.id ?? ""}`, promotedFrom: sourceRun, blocked: {} },
        reproduction: { certificate: check.id, sourceRun },
      },
    });
    io.write(`Reproducing ${ticket} run ${sourceRun} (certificate ${check.id ?? ""}) as run ${ws.runId}\n`);
    const code = await runRun(
      ticket,
      { run: ws.runId, env: options.env, build: options.build, user: options.user },
      io,
      ports,
    );
    if (code === 3) return 3;

    // AC2: the comparison, recorded in the new run only (AC3).
    const after = await openSession(ticket, ws.runId, io.cwd, ports, masker);
    const verdict = await computeVerdict(after, ports.now);
    const statuses = Object.fromEntries(verdict.cases.map((c) => [c.caseId, c.status]));
    const cases = compareReproduction(certifiedStatuses, statuses);
    const versions = diffVersions(p.versions ?? {}, verdict.versions);
    const certifiedImages = ((p.images ?? []) as { container?: string; id?: string }[]).map(
      (i) => i.id ?? "",
    );
    const build = (after.ws.record.data["build"] ?? {}) as { images?: { id?: string }[] };
    const images =
      options.build === true
        ? (build.images ?? []).map((i) => i.id ?? "").filter((id) => !certifiedImages.includes(id))
        : [];
    const comparison = { certificate: check.id, sourceRun, cases, versions, newImages: images };
    await after.ws.update({ data: { ...after.ws.record.data, reproduction: comparison } });
    after.events.emit("certificate", { kind: "system", name: "orchestrator" }, "reproduction.compared", {
      same: cases.filter((c) => c.result === "same").length,
      different: cases.filter((c) => c.result === "different").length,
      notReproducible: cases.filter((c) => c.result === "not reproducible").length,
    });
    io.write(
      [
        `Reproduction of ${sourceRun} (certificate ${check.id ?? ""}) in run ${ws.runId}:`,
        ...cases.map((c) => `  ${c.caseId}: ${c.before} → ${c.after}  ${c.result}`),
        ...(versions.length > 0 ? [`  tools that differ: ${versions.join(", ")}`] : []),
        ...(images.length > 0 ? [`  container images not in the certificate: ${images.join(", ")}`] : []),
        "",
      ].join("\n"),
    );
    if (cases.some((c) => c.result === "different")) return 1;
    return cases.some((c) => c.result === "not reproducible") ? 2 : 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
