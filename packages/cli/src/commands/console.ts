import { dirname } from "node:path";
import { listProjects, projectPaths, QajitsuError, qajitsuHome, type ResolvedProject } from "@qajitsu/core";
import type { RuntimePorts } from "../adapters.js";
import {
  startConsole,
  type ActionResult,
  type ActionTarget,
  type ConsoleActions,
} from "../console/server.js";
import type { ModelPorts } from "../session.js";
import type { CommandIO } from "./fetch.js";
import { applyPlanEdit, runApprove, runPlan } from "./plan.js";
import type { RunPorts } from "./run.js";

/**
 * The console's buttons (REQ-WEB-01/AC3, REQ-WEB-07/AC3): approve, revise and edit run `qj approve`, `qj plan
 * --revise` and the plan edit of `qj plan` on the project the run belongs to, with their rules (confirmations, the
 * project's whole approval flow with its model steps, the plan checks), as the person who started the console, one at
 * a time per run. What they print is the answer.
 *
 * @param ports - The command's ports.
 * @param user - The person approving (as `qj approve` records it).
 */
export function consoleActions(ports: RuntimePorts & ModelPorts, user: string): ConsoleActions {
  const on = async (
    target: ActionTarget,
    run: (io: CommandIO, ports: RuntimePorts & ModelPorts) => Promise<number>,
  ): Promise<ActionResult> => {
    const home = qajitsuHome(ports.env, ports.home);
    const record = (await listProjects(home)).find((p) => p.slug === target.slug);
    if (!record) return { ok: false, output: `No project ${target.slug}.` };
    const project: ResolvedProject = {
      slug: record.slug,
      record,
      paths: projectPaths(home, record.slug),
      via: "console",
    };
    let output = "";
    const io: CommandIO = {
      write: (t) => (output += t),
      writeError: (t) => (output += t),
      cwd: dirname(record.qa_dir),
    };
    const code = await run(io, { ...ports, project });
    return { ok: code === 0, output };
  };
  const review = { user };
  // One action at a time per run: an edit and an approval never race on the same plan.
  const queues = new Map<string, Promise<unknown>>();
  const serial = (target: ActionTarget, work: () => Promise<ActionResult>): Promise<ActionResult> => {
    const key = `${target.slug}/${target.ticket}/${target.runId}`;
    const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
    queues.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  };
  return {
    approve: (target, o) =>
      serial(target, () =>
        on(target, (io, p) =>
          runApprove(
            target.ticket,
            {
              run: target.runId,
              version: String(o.version),
              confirmUncovered: o.confirmUncovered,
              confirmPlaceholders: o.confirmPlaceholders,
              confirmOpenQuestions: o.confirmOpenQuestions,
            },
            io,
            p,
            review,
          ),
        ),
      ),
    revise: (target, instruction) =>
      serial(target, () =>
        on(target, (io, p) =>
          runPlan(target.ticket, { run: target.runId, revise: instruction }, io, p, review),
        ),
      ),
    edit: (target, text) =>
      serial(target, () =>
        on(target, (io, p) => applyPlanEdit(target.ticket, { run: target.runId, text }, io, p, review)),
      ),
  };
}

/**
 * `qajitsu console [--port <n>]`: the local web console over every registered project (REQ-WEB-01), on 127.0.0.1
 * until Ctrl+C. The printed address carries a one-time token: only the browser that opens it is let in. Its buttons
 * approve, revise and edit plans as the person who started it.
 *
 * @returns 0 after Ctrl+C, 3 on errors.
 */
export async function runConsole(
  options: { readonly port?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & Pick<RunPorts, "signals">,
  user = "unknown",
): Promise<number> {
  const signals = ports.signals ?? process;
  let stop: () => void = () => undefined;
  const onSignal = (): void => {
    stop();
  };
  try {
    const port = options.port === undefined ? 0 : Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      io.writeError("--port must be a port number.\n");
      return 3;
    }
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    signals.on("SIGINT", onSignal);
    signals.on("SIGTERM", onSignal);
    const server = await startConsole({
      env: ports.env,
      userHome: ports.home,
      port,
      actions: consoleActions(ports, user),
    });
    io.write(
      `QAJitsu console: ${server.url}\nOpen it in your browser (the address signs you in once; keep it to yourself). Approvals are recorded as ${user}. Press Ctrl+C to stop.\n`,
    );
    await stopped;
    await server.close();
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  } finally {
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
  }
}
