import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createFilePublisher, createJiraPublisher } from "@qajitsu/adapter-publish-jira";
import {
  ConfigError,
  GateFailedError,
  QajitsuError,
  type PublishAttachment,
  type Publisher,
} from "@qajitsu/core";
import {
  renderCommentPreview,
  renderJiraAdf,
  renderJiraWiki,
  zip,
  type CommentFailure,
  type CommentModel,
} from "@qajitsu/report";
import { createMasker } from "@qajitsu/steps";
import { gateNoSecrets } from "@qajitsu/verifier";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";
import { computeVerdict, writeReports, type RunVerdict } from "./verdict.js";

/** Options of `qajitsu publish`. */
export interface PublishOptions {
  readonly run?: string | undefined;
  /** Skip the confirmation preview (REQ-VER-10/AC2). */
  readonly autoPublish?: boolean | undefined;
}

/** What `run.json` remembers about publishing (REQ-PUB-04/AC1, REQ-VER-10/AC2). */
interface PublishRecord {
  readonly commentId: string;
  readonly url?: string | undefined;
  readonly at: string;
  readonly publisher: string;
  readonly preview: "confirmed" | "auto";
  readonly attachmentNames: readonly string[];
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webm: "video/webm",
  mp4: "video/mp4",
  zip: "application/zip",
};

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Builds `<TICKET>_<RUN-ID>_evidence.zip` with evidence, manifest and report (REQ-PUB-02/AC1). */
async function buildEvidenceZip(session: RunSession): Promise<PublishAttachment> {
  const { ws } = session;
  const files = [
    ...(await listFiles(ws.path("evidence"))),
    ws.path("report", "report.html"),
    ws.path("report", "matrix.md"),
    ws.path("report", "matrix.csv"),
  ];
  const entries = await Promise.all(
    files.map(async (f) => ({
      name: relative(ws.dir, f).split("\\").join("/"),
      data: new Uint8Array(await readFile(f)),
    })),
  );
  const name = `${ws.ticket}_${ws.runId}_evidence.zip`;
  const path = ws.path("report", name);
  const data = zip(entries);
  await writeFile(path, data);
  return { path, name, mimeType: "application/zip", bytes: data.byteLength };
}

/** Builds the comment model from the computed verdict (REQ-PUB-01). */
function commentModel(
  session: RunSession,
  v: RunVerdict,
  user: string,
  now: Date,
  attachments: readonly PublishAttachment[],
  notes: readonly string[],
): CommentModel {
  const { ws, masker } = session;
  const failures: CommentFailure[] = v.cases.flatMap((c) => {
    if (c.status !== "FAILED" && c.status !== "FLAKY") return [];
    const title = v.plan.cases.find((p) => p.id === c.caseId)?.title ?? c.caseId;
    return c.failures.map((f) => ({
      caseId: c.caseId,
      title,
      status: c.status,
      stepId: f.stepId,
      field: f.field,
      expected: masker.maskJson(f.expected),
      actual: masker.maskJson(f.actual),
      attachments: attachments.filter((a) => a.name.startsWith(`${c.caseId}_${f.stepId}`)).map((a) => a.name),
    }));
  });
  return {
    ticket: ws.ticket,
    runId: ws.runId,
    date: now.toISOString(),
    environment: v.environment,
    repos: Object.fromEntries(Object.entries(ws.record.repos).map(([k, r]) => [k, r.sha])),
    executor: user,
    planVersion: v.approval.version,
    planSha256: v.approval.sha256,
    rows: v.rows,
    summary: v.summary,
    failures,
    reproduce: `qajitsu evidence ${ws.ticket} --run ${ws.runId} --failed`,
    attachments: attachments.map((a) => a.name),
    notes,
  };
}

function publisherFor(session: RunSession, ports: RuntimePorts): Publisher {
  const { project, ws, masker, logger } = session;
  const jira = project.config.jira;
  if (jira.type === "file") return createFilePublisher(ws.path("report", "published"));
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
      logger,
      now: ports.now,
      resolveSecret: session.resolveSecret,
      registerSecret: (v) => {
        masker.register(v);
      },
    },
  );
}

/**
 * `qajitsu publish <TICKET>`: posts the results comment and attachments to the ticket (REQ-PUB-01..04).
 * Statuses and gates are recomputed from disk first; nothing is published unless every gate passes
 * and a human confirmed the preview, or auto-publish was chosen explicitly (REQ-VER-07, REQ-VER-10).
 *
 * @returns 0 published, 3 refused or failed.
 */
export async function runPublish(
  rawKey: string,
  options: PublishOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
  user: string,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const { ws, events, project } = session;
    if (ws.record.data["results"] === undefined)
      throw new ConfigError("RUN_NOT_EXECUTED", "This run has no results yet; run 'qajitsu run' first.", {});
    const verdict = await computeVerdict(session, ports.now);
    await writeReports(session, verdict);
    if (!verdict.ok) {
      throw new GateFailedError(
        "PUBLISH_GATES_FAILED",
        `Publish gates failed: ${verdict.failed.map((g) => `${g.gate} (${g.problems.slice(0, 3).join("; ")})`).join(", ")}`,
        {
          gates: verdict.failed.map((g) => g.gate),
        },
      );
    }
    const evidenceZip = await buildEvidenceZip(session);
    // Failure screenshots and videos are attached individually so they show without unzipping (REQ-PUB-02/AC2).
    const failing = new Set(
      verdict.cases.filter((c) => c.status === "FAILED" || c.status === "FLAKY").map((c) => c.caseId),
    );
    const media: PublishAttachment[] = [];
    for (const m of verdict.manifest.filter(
      (e) => failing.has(e.caseId) && (e.kind === "screenshot" || e.kind === "video"),
    )) {
      const ext = m.path.split(".").at(-1) ?? "bin";
      media.push({
        path: ws.path("evidence", m.path),
        name: `${m.caseId}_${m.stepId ?? "case"}_${m.path.split("/").at(-1) ?? m.path}`,
        mimeType: MIME[ext] ?? "application/octet-stream",
        bytes: (await stat(ws.path("evidence", m.path))).size,
      });
    }
    const limit = project.config.publish.max_attachment_mb * 1_000_000;
    const notes = [evidenceZip, ...media]
      .filter((a) => a.bytes > limit)
      .map(
        (a) =>
          `${a.name} (${String(Math.ceil(a.bytes / 1e6))} MB) is larger than the ${String(project.config.publish.max_attachment_mb)} MB limit and stays in the run folder.`,
      );
    const attachments = [evidenceZip, ...media];
    const model = commentModel(
      session,
      verdict,
      user,
      ports.now(),
      attachments.filter((a) => a.bytes <= limit),
      notes,
    );
    const adf = renderJiraAdf(model);
    const wiki = renderJiraWiki(model);
    const preview = renderCommentPreview(model);
    const secrets = gateNoSecrets(
      [
        { name: "comment (ADF)", text: JSON.stringify(adf) },
        { name: "comment (wiki)", text: wiki },
        { name: evidenceZip.name, text: (await readFile(evidenceZip.path)).toString("latin1") },
      ],
      (t) => masker.containsSecret(t),
    );
    if (!secrets.ok)
      throw new GateFailedError(
        "PUBLISH_GATES_FAILED",
        `Secret scan failed: ${secrets.problems.join("; ")}`,
        {},
      );

    // REQ-VER-10: human preview by default; auto-publish only when chosen, and recorded.
    io.write(`${preview}\n`);
    const auto = options.autoPublish === true || project.config.publish.auto;
    let mode: PublishRecord["preview"];
    if (auto) {
      mode = "auto";
    } else if (io.ask) {
      const answer = (await io.ask(`Publish this to ${ws.ticket}? [y/N] `)).trim().toLowerCase();
      events.emit("publish", { kind: "user", name: user }, "publish.preview", { answer });
      if (answer !== "y" && answer !== "yes") {
        io.write("Not published.\n");
        return 0;
      }
      mode = "confirmed";
    } else {
      throw new ConfigError(
        "PUBLISH_PREVIEW_REQUIRED",
        "Publishing needs a confirmed preview; pass --auto-publish or set publish.auto in CI.",
        {},
      );
    }

    const previous = ws.record.data["publish"] as PublishRecord | undefined;
    const publisher = publisherFor(session, ports);
    const result = await publisher.publish({
      ticket: ws.ticket,
      runId: ws.runId,
      comment: { adf, wiki },
      attachments,
      ...(previous
        ? { previous: { commentId: previous.commentId, attachmentNames: previous.attachmentNames } }
        : {}),
    });
    const record: PublishRecord = {
      commentId: result.commentId,
      url: result.url,
      at: ports.now().toISOString(),
      publisher: publisher.id,
      preview: mode,
      attachmentNames: [
        ...new Set([...(previous?.attachmentNames ?? []), ...result.attachments.map((a) => a.name)]),
      ],
      skipped: result.skipped,
    };
    await ws.update({
      data: { ...ws.record.data, publish: record },
      checkpoints: [...ws.record.checkpoints, { stage: "publish", at: record.at }],
    });
    events.emit("publish", { kind: "user", name: user }, "publish.done", {
      commentId: result.commentId,
      updated: result.updated,
      preview: mode,
      attachments: result.attachments.length,
      skipped: result.skipped.length,
    });
    io.write(
      `${result.updated ? "Updated" : "Published"} ${ws.ticket} comment ${result.commentId}${result.url ? `: ${result.url}` : ""}\n`,
    );
    for (const s of result.skipped) io.write(`  not attached: ${s.name} (${s.reason})\n`);
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
