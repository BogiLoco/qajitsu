import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  ConfigError,
  GateFailedError,
  QajitsuError,
  RunIdSchema,
  TicketKeySchema,
  approvePlan,
  createGitRepos,
  createRunWorkspace,
  exitCodeFor,
  renderTicketMarkdown,
  resolveWorkspaceRoot,
  sha256,
  writePlanVersion,
  type TestStatus,
  type Ticket,
} from "@qajitsu/core";
import {
  renderRegressionComment,
  renderRegressionHtml,
  renderRegressionJUnit,
  renderRegressionMarkdown,
  type RegressionCaseRow,
  type RegressionModel,
  type RegressionPackProblem,
} from "@qajitsu/report";
import { createMasker, type Masker } from "@qajitsu/steps";
import { gateNoSecrets } from "@qajitsu/verifier";
import { parse } from "yaml";
import { buildAdapters, createCliSecretResolver, type RuntimePorts } from "../adapters.js";
import { createCliLogger } from "../logger.js";
import { loadProject, resolveConfigPath, type LoadedProject } from "../project.js";
import { openSession, registerConfiguredSecrets, type ModelPorts } from "../session.js";
import type { CommandIO } from "./fetch.js";
import { packCasesSha256, RegressionPackSchema, type RegressionPack } from "./pack.js";
import { projectPublisher } from "./release.js";
import { runRun, type RunPorts } from "./run.js";
import { computeVerdict } from "./verdict.js";

/** Options of `qajitsu regression`. */
export interface RegressionOptions {
  readonly env?: string | undefined;
  /** Comma-separated tickets of the packs to run (default: every pack). */
  readonly packs?: string | undefined;
  /** A folder with packs instead of the tests repository. */
  readonly from?: string | undefined;
  /** Branch, tag or commit of the tests repository (default: its `default_ref`). */
  readonly ref?: string | undefined;
  /** Ticket that receives the report as a comment after preview. */
  readonly publish?: string | undefined;
  readonly yes?: boolean | undefined;
  readonly user?: string | undefined;
}

/** A pack found on disk: its folder and its parsed `expectations.yaml`, or why it cannot run. */
interface FoundPack {
  readonly dir: string;
  readonly pack?: RegressionPack;
  /** `cases` exactly as written in the file, for the hash check. */
  readonly rawCases?: unknown;
  readonly problem?: string;
}

const SKIP = new Set([".git", "node_modules", "dist", "build"]);

/** Every `expectations.yaml` of kind `qajitsu-regression-pack` below `root` (at most 6 levels deep). */
async function findPacks(root: string, depth = 0): Promise<FoundPack[]> {
  const out: FoundPack[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory() && !SKIP.has(e.name) && depth < 6)
      out.push(...(await findPacks(join(root, e.name), depth + 1)));
    else if (e.isFile() && e.name === "expectations.yaml") {
      let raw: unknown;
      try {
        raw = parse(await readFile(join(root, e.name), "utf8")) as unknown;
      } catch {
        out.push({ dir: root, problem: "expectations.yaml is not valid YAML" });
        continue;
      }
      if ((raw as { kind?: unknown } | null)?.kind !== "qajitsu-regression-pack") continue;
      const parsed = RegressionPackSchema.safeParse(raw);
      out.push(
        parsed.success
          ? { dir: root, pack: parsed.data, rawCases: (raw as { cases: unknown }).cases }
          : {
              dir: root,
              problem: `expectations.yaml is not a valid pack: ${parsed.error.issues
                .slice(0, 3)
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; ")}`,
            },
      );
    }
  }
  return out;
}

/**
 * Checks a pack against its own hashes (REQ-EXEC-17/AC2): the expected values against `cases_sha256`, every spec
 * against `specs`. Returns the BLOCKED reason per case; an empty map means every case may run.
 */
async function checkPack(found: FoundPack & { pack: RegressionPack }): Promise<Map<string, string>> {
  const { pack, dir } = found;
  const blocked = new Map<string, string>();
  const ids = pack.cases.map((c) => c.id);
  const casesProblem =
    pack.cases_sha256 === undefined
      ? "the pack records no hash of its expected values (cases_sha256); promote it again"
      : packCasesSha256(found.rawCases as unknown[]) !== pack.cases_sha256
        ? "the expected values in expectations.yaml changed since the pack was promoted"
        : undefined;
  for (const id of ids) {
    if (casesProblem !== undefined) {
      blocked.set(id, casesProblem);
      continue;
    }
    const recorded = pack.specs[id];
    const bytes = await readFile(join(dir, `${id}.qajitsu.ts`)).catch(() => undefined);
    if (recorded === undefined || bytes === undefined)
      blocked.set(id, `the pack has no spec for ${id} (${id}.qajitsu.ts with its hash)`);
    else if (sha256(bytes) !== recorded)
      blocked.set(id, `${id}.qajitsu.ts changed since the pack was promoted`);
  }
  return blocked;
}

/** The frozen ticket of a regression run: only what the pack knows. */
const packTicket = (key: Ticket["key"], pack: RegressionPack): Ticket => ({
  key,
  summary: `Regression pack ${pack.ticket}`,
  description: `Promoted from QAJitsu run ${pack.run} by ${pack.promoted_by} on ${pack.promoted_at}; plan v${String(pack.plan.version)} approved by ${pack.plan.approved_by}.`,
  issueType: "Regression",
  status: "-",
  labels: ["qajitsu-regression"],
  components: [],
  acceptanceCriteria: [],
  comments: [],
  linkedKeys: [],
  attachments: [],
  developmentLinks: [],
});

/** Checks out the tests repository at `ref` (default: its default branch) and returns the folder and a cleanup. */
async function checkoutTestsRepo(
  project: LoadedProject,
  ports: RuntimePorts,
  masker: Masker,
  ref: string | undefined,
  target: string,
): Promise<{ dir: string; label: string; done: () => Promise<void> }> {
  const tests = Object.entries(project.config.repos).filter(([, r]) => r.role === "tests");
  const [entry] = tests;
  if (tests.length !== 1 || !entry)
    throw new ConfigError(
      "TESTS_REPO_REQUIRED",
      tests.length === 0
        ? "No tests repository: declare one with 'repos.<alias>.role: tests', or give a folder with --from."
        : `Several tests repositories (${tests.map(([a]) => a).join(", ")}); give a folder with --from.`,
      {},
    );
  const [alias, repo] = entry;
  const resolveSecret = createCliSecretResolver(project, ports, masker);
  const logger = createCliLogger({ file: join(target, "qajitsu.log"), mask: (v) => masker.maskJson(v) });
  const { codeHosts } = buildAdapters(
    project,
    {
      fetch: ports.fetch,
      logger,
      now: ports.now,
      resolveSecret,
      registerSecret: (v) => {
        masker.register(v);
      },
    },
    ports,
  );
  const host = codeHosts[repo.host];
  if (!host) throw new ConfigError("REPO_UNKNOWN", `Code host '${repo.host}' is not configured.`, {});
  const head = await host.resolveChange({ repo: repo.path, kind: "branch", id: ref ?? repo.default_ref });
  const git = createGitRepos({
    cacheDir: resolveConfigPath(
      project.config.workspace.git_cache ?? "~/.qa-cache/git",
      project.qaDir,
      ports.home,
    ),
    exec: ports.gitExec,
  });
  const cloneUrl = await host.cloneUrl(repo.path);
  const mirror = await git.ensureMirror(repo.host, repo.path, cloneUrl);
  const dir = join(target, alias);
  await git.addWorktree(mirror, head.headSha, dir, cloneUrl);
  return {
    dir,
    label: `${alias}@${head.headSha.slice(0, 12)}`,
    done: async () => {
      await ports.gitExec(["-C", mirror, "worktree", "remove", "--force", dir]).catch(() => undefined);
    },
  };
}

/**
 * `qajitsu regression [--env] [--packs T1,T2] [--from <dir>]`: runs the packs `qj promote` put in the tests
 * repository again, without any agent or model (REQ-EXEC-17). Each pack becomes a run of its ticket with the pack's
 * cases as the approved plan and its specs unchanged; a spec or expected value that does not match the pack's
 * hashes makes its case BLOCKED. Statuses come from the verifier; the suite report (Markdown, HTML, JUnit) lists the
 * cases that passed when promoted and fail now as regressions. `--publish <KEY>` comments it after a preview.
 *
 * @returns The exit code of `qj run` over all cases (0 all passed, 1 a regression, 2 otherwise), 3 on errors.
 */
export async function runRegression(
  options: RegressionOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & RunPorts,
): Promise<number> {
  const masker = createMasker();
  let cleanup: (() => Promise<void>) | undefined;
  try {
    let target: Ticket["key"] | undefined;
    if (options.publish !== undefined) {
      const parsed = TicketKeySchema.safeParse(options.publish);
      if (!parsed.success)
        throw new ConfigError("TICKET_KEY_INVALID", "--publish needs a Jira key like SHOP-500.", {});
      target = parsed.data;
    }
    const project = await loadProject(io.cwd, ports.project);
    await registerConfiguredSecrets(project, createCliSecretResolver(project, ports, masker));
    const root = resolveWorkspaceRoot({
      configured: project.config.workspace.root,
      home: ports.home,
      cwd: project.qaDir,
    });
    const now = ports.now();
    const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
    // REQ-PRJ-10/AC2: outputs go to the project's exports/.
    const outDir = join(
      project.project ? project.project.paths.exports : join(root, "exports"),
      "regression",
      stamp,
    );
    await mkdir(outDir, { recursive: true });

    let source: { dir: string; label: string };
    if (options.from !== undefined) {
      const dir = resolve(io.cwd, options.from);
      source = { dir, label: relative(io.cwd, dir) || "." };
    } else {
      const checkout = await checkoutTestsRepo(project, ports, masker, options.ref, join(outDir, "repo"));
      cleanup = checkout.done;
      source = checkout;
    }
    const wanted = options.packs
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const found = (await findPacks(source.dir)).filter(
      (f) => wanted === undefined || (f.pack !== undefined && wanted.includes(f.pack.ticket)),
    );
    const problems: RegressionPackProblem[] = found
      .filter((f) => f.problem !== undefined)
      .map((f) => ({ path: relative(source.dir, f.dir) || ".", problem: f.problem ?? "" }));
    const packs = found.filter((f): f is FoundPack & { pack: RegressionPack } => f.pack !== undefined);
    if (packs.length === 0 && problems.length === 0) {
      io.writeError(
        `No regression packs found in ${source.label}${wanted ? ` for ${wanted.join(", ")}` : ""}.\n`,
      );
      return 2;
    }

    const cases: RegressionCaseRow[] = [];
    let environment = options.env ?? project.config.environments.default ?? "-";
    for (const found of packs) {
      const { pack } = found;
      const path = relative(source.dir, found.dir) || ".";
      const key = TicketKeySchema.safeParse(pack.ticket);
      if (!key.success) {
        problems.push({ path, problem: `'${pack.ticket}' is not a ticket key` });
        continue;
      }
      const blocked = await checkPack(found);
      // The pack becomes a run of its ticket: its cases are the approved plan, its specs run unchanged.
      const ws = await createRunWorkspace({ root, ticket: key.data, now: ports.now, random: ports.random });
      const ticket = packTicket(key.data, pack);
      await writeFile(ws.path("ticket", "ticket.json"), `${JSON.stringify(ticket, null, 2)}\n`);
      await writeFile(ws.path("ticket", "ticket.md"), renderTicketMarkdown(ticket));
      await ws.update({
        data: {
          ...ws.record.data,
          ...(ports.project ? { project: ports.project.slug } : {}),
          regression: { pack: path, promotedFrom: pack.run, blocked: Object.fromEntries(blocked) },
        },
      });
      await writePlanVersion(ws, {
        summary: `Regression pack ${pack.ticket}: promoted from run ${pack.run}, plan v${String(pack.plan.version)} approved by ${pack.plan.approved_by}.`,
        cases: pack.cases,
        open_questions: [],
        out_of_scope: [],
        selection: [],
        existing_coverage: [],
      });
      await approvePlan(ws, {
        approver: `${pack.plan.approved_by} (regression pack ${pack.run})`,
        now: ports.now,
      });
      for (const c of pack.cases)
        if (!blocked.has(c.id))
          await copyFile(join(found.dir, `${c.id}.qajitsu.ts`), ws.path("specs", `${c.id}.spec.ts`));
      io.write(`\n== Regression pack ${pack.ticket} (${path}), run ${ws.runId} ==\n`);
      const code = await runRun(
        pack.ticket,
        { run: ws.runId, env: options.env, user: options.user },
        io,
        ports,
      );
      if (code === 3) {
        problems.push({
          path,
          problem: `the run ${ws.runId} could not complete; see qj logs ${pack.ticket} --run ${ws.runId}`,
        });
        continue;
      }
      const session = await openSession(pack.ticket, ws.runId, io.cwd, ports, masker);
      const verdict = await computeVerdict(session, ports.now);
      environment = verdict.environment.name;
      for (const c of verdict.cases) {
        const first = c.failures[0];
        const reason =
          blocked.get(c.caseId) ??
          (first
            ? `${first.stepId} ${first.field}: expected ${JSON.stringify(first.expected)}, actual ${JSON.stringify(first.actual)}`
            : c.error);
        cases.push({
          ticket: pack.ticket,
          caseId: c.caseId,
          title: verdict.plan.cases.find((p) => p.id === c.caseId)?.title ?? c.caseId,
          type: verdict.plan.cases.find((p) => p.id === c.caseId)?.type ?? "api",
          status: c.status,
          runId: ws.runId,
          ...(reason && c.status !== "PASSED" ? { reason: masker.maskText(reason).slice(0, 300) } : {}),
        });
      }
    }

    const model: RegressionModel = {
      date: now.toISOString().slice(0, 16).replace("T", " "),
      source: source.label,
      environment,
      cases,
      problems,
    };
    const markdown = masker.maskText(renderRegressionMarkdown(model));
    await writeFile(join(outDir, "regression.md"), markdown);
    await writeFile(join(outDir, "report.html"), masker.maskText(renderRegressionHtml(model)));
    await writeFile(join(outDir, "junit.xml"), masker.maskText(renderRegressionJUnit(model)));
    io.write(`\n${markdown}\nReport: ${join(outDir, "report.html")}\n`);

    if (target !== undefined) {
      const comment = renderRegressionComment(model);
      const adf = masker.maskJson(comment.adf);
      const wiki = masker.maskText(comment.wiki);
      const secrets = gateNoSecrets(
        [
          { name: "regression (ADF)", text: JSON.stringify(adf) },
          { name: "regression (wiki)", text: wiki },
        ],
        (t) => masker.containsSecret(t),
      );
      if (!secrets.ok)
        throw new GateFailedError(
          "PUBLISH_GATES_FAILED",
          `Secret scan failed: ${secrets.problems.join("; ")}`,
          {},
        );
      if (options.yes !== true) {
        const answer = io.ask ? (await io.ask(`Publish this report to ${target}? [y/N] `)).trim() : "";
        if (!/^y(es)?$/i.test(answer)) {
          io.writeError(
            io.ask ? "Not published.\n" : "Not interactive: not published; confirm with --yes.\n",
          );
          return 2;
        }
      }
      const stampId = now.toISOString();
      const runId = RunIdSchema.parse(
        `${stampId.slice(0, 10).replace(/-/g, "")}-${stampId.slice(11, 16).replace(":", "")}-regr`,
      );
      const resolveSecret = createCliSecretResolver(project, ports, masker);
      const logger = createCliLogger({ file: join(outDir, "qajitsu.log"), mask: (v) => masker.maskJson(v) });
      const result = await projectPublisher(project, outDir, ports, {
        logger,
        resolveSecret,
        masker,
      }).publish({
        ticket: target,
        runId,
        comment: { adf, wiki },
        attachments: [],
      });
      io.write(
        `Published regression report on ${target}: comment ${result.commentId}${result.url ? ` (${result.url})` : ""}\n`,
      );
    }
    const statuses: TestStatus[] = cases.map((c) => c.status);
    const code = exitCodeFor(statuses);
    // A pack that could not run is never a clean result.
    return problems.length > 0 && code === 0 ? 2 : code;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  } finally {
    await cleanup?.();
  }
}
