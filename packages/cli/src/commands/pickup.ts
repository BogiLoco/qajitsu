import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { devNull } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  QajitsuError,
  TicketKeySchema,
  openRunWorkspace,
  readRunIndex,
  resolveWorkspaceRoot,
  type RunWorkspace,
  type TicketKey,
  type TicketWorkflow,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { createCliSecretResolver } from "../adapters.js";
import { createCliLogger } from "../logger.js";
import { loadProject, type LoadedProject } from "../project.js";
import { openSession } from "../session.js";
import type { CommandIO } from "./fetch.js";
import { runFetch } from "./fetch.js";
import { runPlan, type ReviewPorts } from "./plan.js";
import type { RunPorts } from "./run.js";
import { publisherFor } from "./publish.js";
import { runWorkflowSync, type SyncPorts } from "./ticket-approval.js";
import { moveToRole, workflowFor } from "./workflow.js";

/** How a ticket was picked up (REQ-FLOW-01). */
export type PickupVia = "poll" | "webhook";

interface PickupContext {
  readonly project: LoadedProject;
  readonly root: string;
  readonly workflow: TicketWorkflow;
  readonly resolveSecret: (ref: string) => Promise<string>;
  readonly maskText: (text: string) => string;
}

/** The project, its runs folder and its workflow; refuses a project that maps no workflow. */
async function pickupContext(io: CommandIO, ports: SyncPorts): Promise<PickupContext> {
  const project = await loadProject(io.cwd, ports.project);
  const flow = project.config.workflow;
  if (!flow)
    throw new ConfigError(
      "FLOW_NOT_CONFIGURED",
      "Picking tickets up needs a workflow section with the team's statuses in the project configuration.",
      {},
    );
  const masker = createMasker();
  const resolveSecret = createCliSecretResolver(project, ports, masker);
  const workflow = workflowFor(project, {
    fetch: ports.fetch,
    now: ports.now,
    logger: createCliLogger({ file: devNull, mask: (v) => masker.maskJson(v) }),
    resolveSecret,
    registerSecret: (v) => {
      masker.register(v);
    },
  });
  if (!workflow) throw new ConfigError("FLOW_NOT_CONFIGURED", "The project maps no workflow.", {});
  const root = resolveWorkspaceRoot({
    configured: project.config.workspace.root,
    home: ports.home,
    cwd: project.qaDir,
  });
  return { project, root, workflow, resolveSecret, maskText: (t) => masker.maskText(t) };
}

/** One line of `<runs>/pickup.jsonl`: what came in and what was done, never a request body. */
async function logPickup(root: string, now: () => Date, entry: Record<string, unknown>): Promise<void> {
  await mkdir(root, { recursive: true });
  await appendFile(join(root, "pickup.jsonl"), `${JSON.stringify({ ts: now().toISOString(), ...entry })}\n`);
}

/**
 * Picks one ticket up (REQ-FLOW-01/AC4): starts a run (`qj fetch`, with its one-active-run and daily checks),
 * moves the ticket to "in testing" with a comment that the run started, plans it (the readiness gate first) and,
 * with an approvers group, posts the plan for approval in the ticket.
 *
 * @returns The new run id, or undefined when no run started.
 */
export async function pickUp(
  ticket: TicketKey,
  via: PickupVia,
  ctx: PickupContext,
  io: CommandIO,
  ports: SyncPorts,
  review: ReviewPorts,
): Promise<string | undefined> {
  const latest = async () => (await readRunIndex(ctx.root, ticket).catch(() => undefined))?.latest;
  const before = await latest();
  const skip = async (reason: string): Promise<undefined> => {
    io.write(`${ticket} not picked up: ${reason}.\n`);
    await logPickup(ctx.root, ports.now, { event: "pickup.skipped", ticket, via, reason });
    return undefined;
  };
  // The tracker decides, never a webhook body: only a ticket in the start status is picked up.
  const start = ctx.project.config.workflow?.statuses.start ?? "";
  const status = await ctx.workflow.status(ticket).catch(() => undefined);
  if (status === undefined) return skip("its status could not be read");
  if (status.toLowerCase() !== start.toLowerCase()) return skip(`it is in "${status}", not "${start}"`);
  // A ticket whose move out of the start status failed would be picked up on every poll: one open run at a time.
  if (before !== undefined) {
    const open = await openRunWorkspace(ctx.root, ticket, before).then(runIsOpen, () => false);
    if (open)
      return skip(`run ${before} is still open; finish it or close it with qajitsu work reset ${ticket}`);
  }
  // No terminal questions while picking up: nobody is there to answer.
  const quiet: CommandIO = { ...io, ask: undefined };
  const fetched = await runFetch(ticket, {}, quiet, ports);
  const runId = await latest();
  if (fetched !== 0 || runId === undefined || runId === before) {
    await logPickup(ctx.root, ports.now, { event: "pickup.not_started", ticket, via, exit: fetched });
    if (fetched !== 0)
      io.writeError(`${ticket} was not picked up: qajitsu fetch ended with exit code ${String(fetched)}.\n`);
    return undefined;
  }
  const session = await openSession(ticket, runId, io.cwd, ports);
  session.events.emit("fetch", { kind: "system", name: "orchestrator" }, "ticket.picked_up", { via });
  const publisher = publisherFor(session, ports);
  await moveToRole(session, quiet, ctx.workflow, publisher, "in_testing", `run ${runId} started`);
  const text = `QAJitsu started run ${runId} for ${ticket} (${via}).`;
  await publisher
    .publish({
      ticket,
      runId,
      name: "started",
      comment: {
        adf: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
        wiki: text,
      },
      attachments: [],
    })
    .catch((error: unknown) => {
      io.writeError(
        `Warning: the start comment was not posted: ${ctx.maskText(error instanceof Error ? error.message : String(error))}\n`,
      );
    });
  await logPickup(ctx.root, ports.now, { event: "pickup.started", ticket, via, run: runId });
  const planned = await runPlan(ticket, { run: runId }, quiet, ports, review);
  if (planned === 0 && ctx.project.config.workflow?.approvers_group !== undefined)
    await runWorkflowSync(ticket, { run: runId }, quiet, ports, review);
  return runId;
}

/**
 * Whether a run of a ticket still waits for something (a plan decision, a run, results): not closed, no results, not
 * rejected in the ticket and not stopped at the readiness gate.
 */
function runIsOpen(ws: RunWorkspace): boolean {
  const d = ws.record.data;
  if (d["closed"] !== undefined || d["results"] !== undefined) return false;
  if ((d["ticketFlow"] as { rejected?: unknown } | undefined)?.rejected !== undefined) return false;
  const readiness = d["readiness"] as { result?: string } | undefined;
  if (readiness?.result !== undefined && readiness.result !== "READY" && d["readinessOverride"] === undefined)
    return false;
  return true;
}

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((done) => {
    if (signal?.aborted) {
      done();
      return;
    }
    const timer = setTimeout(done, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });

/**
 * `qj workflow poll [--once]` (REQ-FLOW-01/AC2): pull mode for workers behind a firewall. Polls the project's tickets in
 * the start status (or `workflow.pickup.jql`) every `interval_s` seconds and picks up at most `batch` per poll, one
 * after the other. Stops on Ctrl+C or after one poll with `--once`.
 */
export async function runWorkflowPoll(
  options: { readonly once?: boolean | undefined },
  io: CommandIO,
  ports: SyncPorts,
  review: ReviewPorts,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const ctx = await pickupContext(io, ports);
    const flow = ctx.project.config.workflow;
    if (!flow) return 3;
    for (;;) {
      const keys = await ctx.workflow
        .findInStatus({
          projectKey: ctx.project.config.jira.project_key,
          status: flow.statuses.start,
          ...(flow.pickup.jql === undefined ? {} : { jql: flow.pickup.jql }),
          limit: flow.pickup.batch,
        })
        .catch((error: unknown) => {
          io.writeError(
            `Warning: polling failed: ${ctx.maskText(error instanceof Error ? error.message : String(error))}\n`,
          );
          return [] as TicketKey[];
        });
      io.write(`Polled: ${String(keys.length)} ticket(s) in "${flow.statuses.start}".\n`);
      for (const key of keys) {
        if (signal?.aborted) break;
        await pickUp(key, "poll", ctx, io, ports, review);
      }
      if (options.once === true || signal?.aborted) return 0;
      await wait(flow.pickup.interval_s * 1000, signal);
      if (signal?.aborted) return 0;
    }
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
}

const MAX_BODY = 64 * 1024;

const sameSecret = (a: string, b: string): boolean =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/**
 * Whether a webhook request carries the shared secret (REQ-FLOW-01/AC3): the `X-QAJitsu-Token` header, or an
 * HMAC-SHA256 of the raw body in `X-Hub-Signature` (`sha256=<hex>`, as Jira webhooks send it). Compared in constant
 * time.
 */
export function webhookAuthorized(
  headers: IncomingMessage["headers"],
  body: Buffer,
  secret: string,
): boolean {
  const token = headers["x-qajitsu-token"];
  if (typeof token === "string" && sameSecret(token, secret)) return true;
  const signature = headers["x-hub-signature"];
  if (typeof signature === "string" && signature.startsWith("sha256=")) {
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    return sameSecret(signature, expected);
  }
  return false;
}

/** The ticket key of a webhook body: `{ "ticket": "KEY-1" }` from an automation rule or `{ "issue": { "key" } }`. */
export function webhookTicket(body: unknown, projectKey: string): TicketKey | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const b = body as { ticket?: unknown; issue?: { key?: unknown } };
  const key = typeof b.ticket === "string" ? b.ticket : b.issue?.key;
  if (typeof key !== "string") return undefined;
  const parsed = TicketKeySchema.safeParse(key);
  return parsed.success && parsed.data.startsWith(`${projectKey}-`) ? parsed.data : undefined;
}

/** A running webhook server. */
export interface PickupServer {
  readonly url: string;
  /** Resolves when every accepted ticket was handled. */
  readonly idle: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * Starts the push-mode webhook (REQ-FLOW-01/AC1+AC3): `POST /jira` with the shared secret; anything else is refused and
 * logged without its body. Accepted tickets are picked up one after the other; the same ticket queued twice is picked
 * up once.
 */
export async function startPickupServer(
  io: CommandIO,
  ports: SyncPorts,
  review: ReviewPorts,
  options: { readonly host?: string | undefined; readonly port?: number | undefined } = {},
): Promise<PickupServer> {
  const ctx = await pickupContext(io, ports);
  const flow = ctx.project.config.workflow;
  if (!flow?.pickup.secret)
    throw new ConfigError(
      "WEBHOOK_SECRET_MISSING",
      "The webhook needs workflow.pickup.secret (a secret:// reference); it never runs unauthenticated.",
      {},
    );
  const secret = await ctx.resolveSecret(flow.pickup.secret);
  const projectKey = ctx.project.config.jira.project_key;
  const queued = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  const refuse = async (
    res: ServerResponse,
    status: number,
    reason: string,
    remote: string | undefined,
  ): Promise<void> => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: reason }));
    await logPickup(ctx.root, ports.now, { event: "webhook.refused", status, reason, remote });
    io.writeError(`Webhook refused (${String(status)}): ${reason}\n`);
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const remote = req.socket.remoteAddress;
      if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/jira") {
        await refuse(res, 404, "not found", remote);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) {
          await refuse(res, 413, "body too large", remote);
          req.destroy();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);
      if (!webhookAuthorized(req.headers, body, secret)) {
        await refuse(res, 401, "unauthenticated", remote);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        await refuse(res, 400, "body is not JSON", remote);
        return;
      }
      const ticket = webhookTicket(parsed, projectKey);
      if (!ticket) {
        await refuse(res, 400, `no ${projectKey} ticket key in the body`, remote);
        return;
      }
      if (queued.has(ticket)) {
        res
          .writeHead(202, { "content-type": "application/json" })
          .end(JSON.stringify({ ticket, queued: false }));
        await logPickup(ctx.root, ports.now, { event: "webhook.duplicate", ticket });
        return;
      }
      queued.add(ticket);
      res
        .writeHead(202, { "content-type": "application/json" })
        .end(JSON.stringify({ ticket, queued: true }));
      await logPickup(ctx.root, ports.now, { event: "webhook.accepted", ticket });
      chain = chain
        .then(() => pickUp(ticket, "webhook", ctx, io, ports, review))
        .then(
          () => undefined,
          (error: unknown) => {
            io.writeError(
              `Pick-up of ${ticket} failed: ${ctx.maskText(error instanceof Error ? error.message : String(error))}\n`,
            );
          },
        )
        .finally(() => {
          queued.delete(ticket);
        });
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  // A client that sends slowly is cut off instead of holding the server.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  const host = options.host ?? flow.pickup.host;
  const port = options.port ?? flow.pickup.port;
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      done();
    });
  });
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${String(bound)}/jira`,
    idle: async () => {
      await chain;
    },
    close: () =>
      new Promise((done) => {
        server.close(() => {
          done();
        });
      }),
  };
}

/**
 * `qj workflow serve` (REQ-FLOW-01/AC1): runs the webhook until Ctrl+C. Jira Automation ("When: issue transitioned to
 * Ready for QA", "Then: send web request") or a Jira webhook posts the ticket to it.
 */
export async function runWorkflowServe(
  options: { readonly host?: string | undefined; readonly port?: string | undefined },
  io: CommandIO,
  ports: SyncPorts & Pick<RunPorts, "signals">,
  review: ReviewPorts,
): Promise<number> {
  try {
    const port = options.port === undefined ? undefined : Number(options.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535))
      throw new ConfigError("PORT_INVALID", `Invalid port '${options.port ?? ""}'.`, {});
    const server = await startPickupServer(io, ports, review, { host: options.host, port });
    io.write(`Listening on ${server.url} (POST with X-QAJitsu-Token or X-Hub-Signature). Ctrl+C stops.\n`);
    const signals = ports.signals ?? process;
    await new Promise<void>((done) => {
      const stop = (): void => {
        signals.off("SIGINT", stop);
        signals.off("SIGTERM", stop);
        done();
      };
      signals.on("SIGINT", stop);
      signals.on("SIGTERM", stop);
    });
    await server.close();
    await server.idle();
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
}
