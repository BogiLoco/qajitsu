import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFilePublisher, createJiraPublisher } from "@qajitsu/adapter-publish-jira";
import {
  ConfigError,
  GateFailedError,
  QajitsuError,
  RunIdSchema,
  TicketKeySchema,
  readRunIndex,
  resolveWorkspaceRoot,
  type Logger,
  type Publisher,
  type ReleaseTicket,
  type TicketKey,
} from "@qajitsu/core";
import {
  renderReleaseAdf,
  renderReleaseMarkdown,
  renderReleaseWiki,
  summarizeRelease,
  type ReleaseModel,
  type ReleaseTicketRow,
} from "@qajitsu/report";
import { createMasker, type Masker } from "@qajitsu/steps";
import { gateNoSecrets } from "@qajitsu/verifier";

import { buildAdapters, createCliSecretResolver, type RuntimePorts } from "../adapters.js";
import { createCliLogger } from "../logger.js";
import { loadProject, type LoadedProject } from "../project.js";
import { openSession, registerConfiguredSecrets, type ModelPorts } from "../session.js";
import { z } from "zod";
import type { CommandIO } from "./fetch.js";
import { computeVerdict } from "./verdict.js";

/** Options of `qajitsu release`. */
export interface ReleaseOptions {
  /** Treat the name as a sprint instead of a fix version. */
  readonly sprint?: boolean | undefined;
  /** Ticket that receives the report as a comment after preview (REQ-PUB-09/AC4). */
  readonly publish?: string | undefined;
  /** Publish without asking. */
  readonly yes?: boolean | undefined;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The ticket's latest executed run, evaluated by the same code as `qj publish` (REQ-PUB-09/AC1+AC3). Runs closed by
 * `qj work reset`, runs of another project and runs without results are skipped; no run gives a row without one.
 */
async function ticketRow(
  ticket: ReleaseTicket,
  root: string,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
  masker: Masker,
): Promise<ReleaseTicketRow> {
  const base = {
    key: ticket.key,
    summary: ticket.summary,
    ticketStatus: ticket.status,
    counts: {},
    open: [],
  };
  const key = TicketKeySchema.safeParse(ticket.key);
  if (!key.success) return { ...base, gatesOk: false };
  const runs = [...(await readRunIndex(root, key.data)).runs].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  for (const entry of runs) {
    const results = await readdir(join(root, key.data, entry.runId, "results")).catch(() => [] as string[]);
    if (!results.some((f) => f.endsWith(".json"))) continue;
    let session;
    try {
      session = await openSession(key.data, entry.runId, io.cwd, ports, masker);
    } catch {
      continue;
    }
    if (session.ws.record.data["closed"] !== undefined) continue;
    try {
      const v = await computeVerdict(session, ports.now);
      const counts: Record<string, number> = {};
      for (const c of v.cases) counts[c.status] = (counts[c.status] ?? 0) + 1;
      const titles = new Map(v.plan.cases.map((c) => [c.id, c.title]));
      return {
        ...base,
        runId: entry.runId,
        counts,
        open: v.cases
          .filter((c) => c.status !== "PASSED")
          .map((c) => ({ caseId: c.caseId, title: titles.get(c.caseId) ?? "", status: c.status })),
        gatesOk: v.ok,
        ...(v.ok ? {} : { problem: `publish gates failed: ${v.failed.map((g) => g.gate).join(", ")}` }),
      };
    } catch (error) {
      return { ...base, runId: entry.runId, gatesOk: false, problem: masker.maskText(message(error)) };
    }
  }
  return { ...base, gatesOk: false };
}

/** Publisher for the release comment: the configured Jira, or files next to the report for `jira.type: file`. */
function releasePublisher(
  project: LoadedProject,
  outDir: string,
  ports: RuntimePorts,
  deps: { logger: Logger; resolveSecret: (ref: string) => Promise<string>; masker: Masker },
): Publisher {
  const jira = project.config.jira;
  if (jira.type === "file") return createFilePublisher(join(outDir, "published"));
  return createJiraPublisher(
    {
      flavor: jira.type,
      baseUrl: jira.base_url ?? "",
      email: jira.email,
      token: jira.token ?? "",
      maxAttachmentBytes: project.config.publish.max_attachment_mb * 1_000_000,
    },
    {
      fetch: ports.fetch,
      logger: deps.logger,
      now: ports.now,
      resolveSecret: deps.resolveSecret,
      registerSecret: (v) => {
        deps.masker.register(v);
      },
    },
  );
}

/** What `<release>.published.json` remembers, so a second publish updates the comment. */
const PublishedSchema = z
  .object({ ticket: z.string().optional(), commentId: z.string().optional() })
  .catch({});

/**
 * `qajitsu release <name> [--sprint] [--publish <KEY>]`: release readiness over every ticket of a fix version or
 * sprint (REQ-PUB-09). Each ticket's latest executed run is evaluated by the same code as `qj publish`; numbers come
 * only from structured results, a ticket without a run is never ready and a run whose gates fail is marked
 * untrusted. The report is written to `exports/releases/<name>.md`; with `--publish` it becomes a comment on that
 * ticket after a preview (updated in place when published again).
 *
 * @returns 0 release ready, 1 not ready, 2 publishing not confirmed, 3 errors.
 */
export async function runRelease(
  name: string,
  options: ReleaseOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    if (name.trim() === "" || name.length > 100)
      throw new ConfigError(
        "RELEASE_NAME_INVALID",
        "Give a fix version or sprint name (at most 100 characters).",
        {},
      );
    let target: TicketKey | undefined;
    if (options.publish !== undefined) {
      const parsed = TicketKeySchema.safeParse(options.publish);
      if (!parsed.success)
        throw new ConfigError("TICKET_KEY_INVALID", "--publish needs a Jira key like SHOP-500.", {});
      target = parsed.data;
    }
    const project = await loadProject(io.cwd, ports.project);
    const resolveSecret = createCliSecretResolver(project, ports, masker);
    await registerConfiguredSecrets(project, resolveSecret);
    const root = resolveWorkspaceRoot({
      configured: project.config.workspace.root,
      home: ports.home,
      cwd: project.qaDir,
    });
    // REQ-PRJ-10/AC2: exports of the project go to its exports/ folder.
    const outDir = project.project ? join(project.project.paths.exports, "releases") : join(root, "releases");
    await mkdir(outDir, { recursive: true });
    const logger = createCliLogger({ file: join(outDir, "qajitsu.log"), mask: (v) => masker.maskJson(v) });
    const deps = {
      fetch: ports.fetch,
      logger,
      now: ports.now,
      resolveSecret,
      registerSecret: (v: string) => {
        masker.register(v);
      },
    };
    const { ticketSource } = buildAdapters(project, deps, ports);
    if (!ticketSource.findTickets)
      throw new ConfigError(
        "RELEASE_UNSUPPORTED",
        "The ticket source cannot list the tickets of a release.",
        {},
      );
    const query = options.sprint === true ? { sprint: name } : { fixVersion: name };
    const tickets = await ticketSource.findTickets(query);
    const rows: ReleaseTicketRow[] = [];
    for (const t of tickets) rows.push(await ticketRow(t, root, io, ports, masker));
    const model: ReleaseModel = {
      name,
      by: options.sprint === true ? "sprint" : "fixVersion",
      date: ports.now().toISOString().slice(0, 10),
      tickets: rows,
    };
    const markdown = masker.maskText(renderReleaseMarkdown(model));
    const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "release";
    const file = join(outDir, `${options.sprint === true ? "sprint-" : ""}${safe}.md`);
    await writeFile(file, markdown);
    io.write(`${markdown}\nReport: ${file}\n`);
    const summary = summarizeRelease(model);

    if (target !== undefined) {
      const adf = masker.maskJson(renderReleaseAdf(model));
      const wiki = masker.maskText(renderReleaseWiki(model));
      const secrets = gateNoSecrets(
        [
          { name: "release (ADF)", text: JSON.stringify(adf) },
          { name: "release (wiki)", text: wiki },
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
      // Publishing the same release to the same ticket again updates the earlier comment.
      const recordFile = `${file.slice(0, -3)}.published.json`;
      const previous = PublishedSchema.parse(
        JSON.parse(await readFile(recordFile, "utf8").catch(() => "{}")) as unknown,
      );
      const now = ports.now().toISOString();
      const runId = RunIdSchema.parse(
        `${now.slice(0, 10).replace(/-/g, "")}-${now.slice(11, 16).replace(":", "")}-rels`,
      );
      const result = await releasePublisher(project, outDir, ports, {
        logger,
        resolveSecret,
        masker,
      }).publish({
        ticket: target,
        runId,
        comment: { adf, wiki },
        attachments: [],
        ...(previous.ticket === target && previous.commentId !== undefined
          ? { previous: { commentId: previous.commentId, attachmentNames: [] } }
          : {}),
      });
      await writeFile(
        recordFile,
        `${JSON.stringify({ ticket: target, commentId: result.commentId, url: result.url, at: now }, null, 2)}\n`,
      );
      io.write(
        `${result.updated ? "Updated" : "Published"} release report on ${target}: comment ${result.commentId}${result.url ? ` (${result.url})` : ""}\n`,
      );
    }
    return summary.releaseReady ? 0 : 1;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(masker.maskText(`Error${code}: ${message(error)}\n`));
    return 3;
  }
}
