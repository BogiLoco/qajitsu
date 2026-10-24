import {
  ConfigError,
  QajitsuError,
  readPlan,
  type Plan,
  type Publisher,
  type TicketComment,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";
import type { KnowledgePorts } from "./knowledge.js";
import { planRisks, runApprove, runPlan, type ReviewPorts } from "./plan.js";
import { publisherFor } from "./publish.js";
import type { SnapshotPorts } from "./app-snapshot.js";
import { moveToRole, runWorkflow } from "./workflow.js";

/** A `/qj` command in a ticket comment (REQ-FLOW-03/AC2). */
export interface QjCommand {
  readonly name: "approve" | "revise" | "reject";
  readonly text: string;
  /** Plan version named in `/qj approve v<N>`. */
  readonly version?: number;
}

/**
 * Parses `/qj approve v<N>`, `/qj revise <instruction>` or `/qj reject <reason>` at the start of a line of a comment.
 * QAJitsu's own comments (they start with "QAJitsu") are never commands, so a plan that quotes a command approves
 * nothing.
 */
export function parseQjCommand(body: string): QjCommand | undefined {
  if (body.trimStart().startsWith("QAJitsu")) return undefined;
  const m = /^[ \t]*\/qj[ \t]+(approve|revise|reject)\b[ \t]*(.*)$/m.exec(body);
  if (!m) return undefined;
  const name = m[1] as QjCommand["name"];
  const text = (m[2] ?? "").trim().slice(0, 2000);
  if (name !== "approve") return { name, text };
  const v = /^v(\d{1,4})\b/.exec(text);
  return v ? { name, text, version: Number(v[1]) } : { name, text };
}

/** One command as recorded in `run.json` and the journal (REQ-FLOW-03/AC7). */
interface CommandRecord {
  readonly id: string;
  readonly command: QjCommand["name"];
  readonly version?: number;
  readonly author: string;
  readonly account: string;
  readonly at: string;
  readonly outcome: string;
}

/** What the ticket approval loop keeps in `run.json` (`data.ticketFlow`). */
interface TicketFlow {
  readonly posted: readonly {
    readonly version: number;
    readonly commentId: string;
    readonly at: string;
    /** Comments the ticket had when this version was posted: none of them can approve it. */
    readonly before: readonly string[];
  }[];
  readonly seen: readonly string[];
  readonly commands: readonly CommandRecord[];
  readonly reminders: readonly { readonly version: number; readonly at: string }[];
  readonly revisions: number;
  readonly rejected?: { readonly reason: string; readonly by: string; readonly at: string };
}

const EMPTY: TicketFlow = { posted: [], seen: [], commands: [], reminders: [], revisions: 0 };
const flowOf = (s: RunSession): TicketFlow => ({
  ...EMPTY,
  ...((s.ws.record.data["ticketFlow"] as Partial<TicketFlow> | undefined) ?? {}),
});

const text = (lines: readonly string[]) => ({
  adf: {
    type: "doc",
    version: 1,
    content: lines.map((l) => ({ type: "paragraph", content: l === "" ? [] : [{ type: "text", text: l }] })),
  },
  wiki: lines.join("\n"),
});

/** What changed between two plan versions, by case id (REQ-FLOW-03/AC2). */
function changeList(before: Plan | undefined, after: Plan): string[] {
  if (!before) return [];
  const old = new Map(before.cases.map((c) => [c.id, JSON.stringify(c)]));
  const now = new Map(after.cases.map((c) => [c.id, JSON.stringify(c)]));
  return [
    ...[...now.keys()].filter((id) => !old.has(id)).map((id) => `added ${id}`),
    ...[...old.keys()].filter((id) => !now.has(id)).map((id) => `removed ${id}`),
    ...[...now].filter(([id, c]) => old.has(id) && old.get(id) !== c).map(([id]) => `changed ${id}`),
  ];
}

/**
 * Posts a plan version to the ticket (REQ-FLOW-03/AC1): version, cases, exclusions, what no case covers and what code
 * cannot check, the change list against the version before, and how to answer. Masked; numbers come from the plan.
 */
async function postPlan(
  session: RunSession,
  publisher: Publisher,
  now: () => Date,
  existing: readonly string[],
): Promise<string> {
  const { ws, masker } = session;
  const { plan } = await readPlan(ws);
  const before =
    plan.version > 1 ? (await readPlan(ws, plan.version - 1).catch(() => undefined))?.plan : undefined;
  const risks = await planRisks(session, plan);
  const changes = changeList(before, plan);
  const v = `v${String(plan.version)}`;
  const lines = [
    `QAJitsu test plan ${v} for ${ws.ticket} (run ${ws.runId}), waiting for approval`,
    `${String(plan.cases.length)} case(s):`,
    ...plan.cases.map((c) => `  ${c.id} [${c.type}, ${c.priority}] ${c.title}`),
    ...(plan.out_of_scope.length > 0 ? ["Not tested:", ...plan.out_of_scope.map((e) => `  ${e}`)] : []),
    ...(risks.gaps.length > 0 ? ["Covered by no case:", ...risks.gaps.map((g) => `  ${g}`)] : []),
    ...(risks.flags.length > 0 ? ["Code cannot check as written:", ...risks.flags.map((f) => `  ${f}`)] : []),
    ...(changes.length > 0
      ? [`Changes since v${String(plan.version - 1)}:`, ...changes.map((c) => `  ${c}`)]
      : []),
    "",
    `Answer with a comment: /qj approve ${v} (approving confirms the lists above), /qj revise <what to change>, or /qj reject <reason>. Silence never approves.`,
  ].map((l) => masker.maskText(l));
  const result = await publisher.publish({
    ticket: ws.ticket,
    runId: ws.runId,
    name: `plan-${v}`,
    comment: text(lines),
    attachments: [],
  });
  const flow = flowOf(session);
  await ws.update({
    data: {
      ...ws.record.data,
      ticketFlow: {
        ...flow,
        posted: [
          ...flow.posted,
          {
            version: plan.version,
            commentId: result.commentId,
            at: now().toISOString(),
            before: [...existing],
          },
        ],
      },
    },
  });
  session.events.emit("approve", { kind: "system", name: "orchestrator" }, "plan.posted_to_ticket", {
    version: plan.version,
    commentId: result.commentId,
    cases: plan.cases.length,
    gaps: risks.gaps.length,
  });
  return v;
}

/** Ports of `qj workflow sync`. */
export type SyncPorts = RuntimePorts & ModelPorts & KnowledgePorts & SnapshotPorts;

/**
 * `qj workflow sync <TICKET>` (REQ-FLOW-03): the plan approval loop in the ticket, run by a scheduler or a Jira
 * automation. Posts a plan version waiting for approval; reads new comments and acts on `/qj approve v<N>`,
 * `/qj revise <text>` and `/qj reject <reason>` from members of `workflow.approvers_group` only; reminds after
 * `remind_after_h` (silence never approves); stops revising after `max_revisions`. Every version, command, author and
 * time goes to the ticket, `run.json` and the journal. Comment text is untrusted: only an authorised person's revise
 * instruction reaches the planner, as the CLI's `--revise` does.
 *
 * @returns 0 when the loop ran, 2 when there is nothing to do yet (no plan), 3 on configuration or tracker errors.
 */
export async function runWorkflowSync(
  rawKey: string,
  options: { readonly run?: string | undefined },
  io: CommandIO,
  ports: SyncPorts,
  review: ReviewPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    let session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const runId = session.ws.runId;
    const reopen = async (): Promise<RunSession> => {
      session = await openSession(rawKey, runId, io.cwd, ports, masker);
      return session;
    };
    const flowConfig = session.project.config.workflow;
    if (!flowConfig?.approvers_group)
      throw new ConfigError(
        "FLOW_NOT_CONFIGURED",
        "Plan approval in the ticket needs workflow.approvers_group in the project configuration.",
        {},
      );
    const group = flowConfig.approvers_group;
    const workflow = runWorkflow(session, ports);
    if (!workflow) throw new ConfigError("FLOW_NOT_CONFIGURED", "The project maps no workflow.", {});
    const publisher = publisherFor(session, ports);
    const latest = async () => (await readPlan(session.ws).catch(() => undefined))?.plan;
    if ((await latest()) === undefined) {
      io.write(`No plan for ${session.ws.ticket} yet; run qajitsu plan first.\n`);
      return 2;
    }
    const approved = () => session.ws.record.data["approval"] !== undefined;
    const ensurePosted = async (): Promise<void> => {
      const plan = await latest();
      if (!plan || approved() || flowOf(session).rejected) return;
      if (flowOf(session).posted.some((p) => p.version === plan.version)) return;
      const existing = (await workflow.comments(session.ws.ticket)).map((c) => c.id);
      const v = await postPlan(session, publisher, ports.now, existing);
      io.write(`Posted plan ${v} to ${session.ws.ticket}.\n`);
      await moveToRole(session, io, workflow, publisher, "waiting_for_approval", `plan ${v} posted`);
    };
    const reply = async (c: TicketComment, lines: readonly string[]): Promise<void> => {
      await publisher
        .publish({
          ticket: session.ws.ticket,
          runId,
          name: `reply-${c.id}`,
          comment: text(
            [`QAJitsu, to ${c.author.name || c.author.account}:`, ...lines].map((l) => masker.maskText(l)),
          ),
          attachments: [],
        })
        .catch((error: unknown) => {
          io.writeError(
            `Warning: no reply posted: ${masker.maskText(error instanceof Error ? error.message : String(error))}\n`,
          );
        });
    };
    const record = async (c: TicketComment, cmd: QjCommand | undefined, outcome: string): Promise<void> => {
      const flow = flowOf(session);
      const entry: CommandRecord | undefined = cmd && {
        id: c.id,
        command: cmd.name,
        ...(cmd.version === undefined ? {} : { version: cmd.version }),
        author: c.author.name,
        account: c.author.account,
        at: c.created,
        outcome,
      };
      await session.ws.update({
        data: {
          ...session.ws.record.data,
          ticketFlow: {
            ...flow,
            seen: [...flow.seen, c.id],
            commands: entry ? [...flow.commands, entry] : flow.commands,
          },
        },
      });
      if (entry) {
        session.events.emit("approve", { kind: "user", name: `jira:${c.author.account}` }, "ticket.command", {
          ...entry,
        });
        io.write(`${c.author.name || c.author.account}: /qj ${entry.command} → ${outcome}\n`);
      }
    };
    // Sub-commands write their own output; it is kept for the reply, masked.
    const captured = (): CommandIO & { readonly text: () => string } => {
      let out = "";
      return {
        ...io,
        ask: undefined,
        write: (t) => (out += t),
        writeError: (t) => (out += t),
        text: () => masker.maskText(out),
      };
    };

    await ensurePosted();
    for (const c of await workflow.comments(session.ws.ticket)) {
      if (flowOf(session).seen.includes(c.id)) continue;
      const cmd = parseQjCommand(c.body);
      if (!cmd) {
        await record(c, undefined, "");
        continue;
      }
      // REQ-FLOW-03/AC3: only the configured group decides; anybody else is answered and ignored.
      if (!(await workflow.inGroup(c.author.account, group).catch(() => false))) {
        await reply(c, [
          `/qj ${cmd.name} ignored: only members of ${group} approve, revise or reject plans.`,
        ]);
        await record(c, cmd, `ignored: not in ${group}`);
        continue;
      }
      const plan = await latest();
      const current = plan?.version ?? 0;
      const flow = flowOf(session);
      // A decided plan stays decided: an approval is frozen (INV-3), a rejection ends the run's planning.
      if (approved()) {
        await reply(c, [`/qj ${cmd.name} ignored: the plan is already approved.`]);
        await record(c, cmd, "ignored: already approved");
        continue;
      }
      if (flow.rejected) {
        await reply(c, [`/qj ${cmd.name} ignored: the plan was rejected; start a new run.`]);
        await record(c, cmd, "ignored: rejected");
        continue;
      }
      if (cmd.name === "approve") {
        // REQ-FLOW-03/AC4: an approval freezes exactly the version it names, and only the one waiting.
        // Only a comment written after the version was posted can approve it: nobody approves what they have not seen.
        const posted = flow.posted.find((x) => x.version === current);
        if (cmd.version !== current || !posted || posted.before.includes(c.id)) {
          const why =
            cmd.version === undefined
              ? `name the version: /qj approve v${String(current)}`
              : cmd.version !== current
                ? `v${String(cmd.version)} is not the version waiting for approval (v${String(current)})`
                : `the comment was written before v${String(current)} was posted to the ticket`;
          await reply(c, [`/qj approve refused: ${why}.`]);
          await record(c, cmd, `refused: ${why}`);
          continue;
        }
        const sub = captured();
        const code = await runApprove(
          rawKey,
          {
            run: runId,
            version: String(current),
            approver: `jira:${c.author.name || c.author.account} (${c.author.account})`,
            confirmUncovered: true,
            confirmPlaceholders: true,
          },
          sub,
          ports,
          review,
        );
        await reopen();
        const sha = (session.ws.record.data["approval"] as { sha256?: string } | undefined)?.sha256;
        await reply(
          c,
          code === 0 && sha !== undefined
            ? [`Plan v${String(current)} approved; sha256 ${sha}.`]
            : [`Plan v${String(current)} was not approved:`, ...sub.text().trim().split("\n").slice(-5)],
        );
        await record(
          c,
          cmd,
          code === 0 && sha !== undefined ? `approved v${String(current)}` : "approval failed",
        );
        // Testing starts now: the ticket leaves "waiting for approval".
        if (code === 0 && sha !== undefined)
          await moveToRole(
            session,
            io,
            workflow,
            publisher,
            "in_testing",
            `plan v${String(current)} approved`,
          );
        continue;
      }
      if (cmd.name === "reject") {
        const reason = masker.maskText(cmd.text) || "no reason given";
        await session.ws.update({
          data: {
            ...session.ws.record.data,
            ticketFlow: { ...flowOf(session), rejected: { reason, by: c.author.account, at: c.created } },
          },
        });
        await reply(c, [`Plan rejected: ${reason}. No testing on this run.`]);
        await record(c, cmd, "rejected");
        await moveToRole(session, io, workflow, publisher, "needs_info", "plan rejected");
        continue;
      }
      // revise
      if (flow.revisions >= flowConfig.max_revisions) {
        await reply(c, [
          `/qj revise not done: ${String(flow.revisions)} revision rounds already. Please edit the plan directly (qajitsu plan ${session.ws.ticket}) and approve it.`,
        ]);
        await record(c, cmd, "refused: revision limit");
        continue;
      }
      if (cmd.text === "") {
        await reply(c, ["/qj revise needs an instruction: /qj revise <what to change>."]);
        await record(c, cmd, "refused: no instruction");
        continue;
      }
      const sub = captured();
      const code = await runPlan(rawKey, { run: runId, revise: cmd.text }, sub, ports, review);
      await reopen();
      await session.ws.update({
        data: {
          ...session.ws.record.data,
          ticketFlow: { ...flowOf(session), revisions: flow.revisions + 1 },
        },
      });
      if (code !== 0)
        await reply(c, ["The plan was not revised:", ...sub.text().trim().split("\n").slice(-5)]);
      await record(
        c,
        cmd,
        code === 0 ? `revised to v${String((await latest())?.version ?? current)}` : "revision failed",
      );
      await ensurePosted();
    }

    // REQ-FLOW-03/AC5: a plan left unanswered gets a reminder; it is never approved by waiting.
    const flow = flowOf(session);
    const plan = await latest();
    const last = [...flow.posted, ...flow.reminders]
      .map((p) => Date.parse(p.at))
      .sort((a, b) => a - b)
      .at(-1);
    if (
      plan &&
      !approved() &&
      !flow.rejected &&
      last !== undefined &&
      ports.now().getTime() - last >= flowConfig.remind_after_h * 3_600_000
    ) {
      const v = `v${String(plan.version)}`;
      await publisher.publish({
        ticket: session.ws.ticket,
        runId,
        name: `reminder-${String(flow.reminders.length + 1)}`,
        comment: text([
          `QAJitsu: plan ${v} of ${session.ws.ticket} is still waiting for approval. Answer /qj approve ${v}, /qj revise <what> or /qj reject <reason>; nothing runs until then.`,
        ]),
        attachments: [],
      });
      await session.ws.update({
        data: {
          ...session.ws.record.data,
          ticketFlow: {
            ...flow,
            reminders: [...flow.reminders, { version: plan.version, at: ports.now().toISOString() }],
          },
        },
      });
      session.events.emit("approve", { kind: "system", name: "orchestrator" }, "plan.reminder", {
        version: plan.version,
      });
      io.write(`Reminded ${session.ws.ticket}: plan ${v} is waiting for approval.\n`);
    }
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
