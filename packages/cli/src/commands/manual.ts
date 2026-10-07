import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  ConfigError,
  QajitsuError,
  type ManualAnswer,
  type ManualPrompter,
  type ManualStepRequest,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { z } from "zod";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";

/** Largest file a tester may attach to a manual step. */
export const MANUAL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const AnswerFileSchema = z.strictObject({
  outcome: z.enum(["passed", "failed"]),
  by: z.string().min(1),
  at: z.string(),
  note: z.string().max(2000).optional(),
  /** Absolute path of a file the tester attached. */
  attachment: z.string().optional(),
});

const fileBase = (r: { caseId: string; stepId: string }): string => `${r.caseId}.${r.stepId}`;

const readAttachment = async (
  path: string | undefined,
): Promise<{ name: string; content: Uint8Array } | undefined> => {
  if (path === undefined || path.trim() === "") return undefined;
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size > MANUAL_ATTACHMENT_MAX_BYTES) return undefined;
  return { name: basename(path), content: await readFile(path) };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/**
 * The person-facing side of manual steps (REQ-EXEC-11/AC2, ADR-0008). In a terminal it shows the instructions and
 * asks for passed or failed, a note and an optional file. Without a terminal it writes
 * `<run>/manual/<TC>.<S>.pending.json` and waits for `qajitsu answer`. No answer within `timeoutMs` resolves
 * undefined, which the runtime turns into an error (BLOCKED). The `manual/` folder is protected from agents.
 */
export function createManualPrompter(
  session: RunSession,
  io: CommandIO,
  options: { readonly user: string; readonly timeoutMs: number; readonly pollMs?: number },
): ManualPrompter {
  const { ws, events } = session;
  const dir = ws.path("manual");
  const system = { kind: "system", name: "orchestrator" } as const;
  return async (request: ManualStepRequest): Promise<ManualAnswer | undefined> => {
    const name = fileBase(request);
    events.emit("run", system, "manual.waiting", { caseId: request.caseId, stepId: request.stepId });
    io.write(
      [
        "",
        `Manual step ${request.caseId} ${request.stepId}: ${request.action}`,
        `  Do: ${request.instructions}`,
        `  Expected: ${request.expected}`,
        "",
      ].join("\n"),
    );
    let answer: ManualAnswer | undefined;
    if (io.ask) {
      const ask = io.ask;
      const interactive = async (): Promise<ManualAnswer | undefined> => {
        let outcome: "passed" | "failed" | undefined;
        while (outcome === undefined) {
          const a = (await ask("Outcome? [p]assed / [f]ailed: ")).trim().toLowerCase();
          outcome = /^p(assed)?$/.test(a) ? "passed" : /^f(ailed)?$/.test(a) ? "failed" : undefined;
        }
        const note = (await ask("Note (optional): ")).trim();
        const file = (await ask("Screenshot or file to attach (path, optional): ")).trim();
        return {
          outcome,
          by: options.user,
          at: new Date().toISOString(),
          ...(note ? { note } : {}),
          ...(file
            ? { attachment: await readAttachment(isAbsolute(file) ? file : resolve(io.cwd, file)) }
            : {}),
        };
      };
      answer = await Promise.race([interactive(), sleep(options.timeoutMs).then(() => undefined)]);
    } else {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${name}.pending.json`),
        `${JSON.stringify({ ...request, created: new Date().toISOString() }, null, 2)}\n`,
      );
      io.write(
        `Waiting for a person (${String(Math.round(options.timeoutMs / 1000))} s): qajitsu answer ${ws.ticket} ${request.caseId} ${request.stepId} --passed|--failed [--note "..."] [--file <path>] --run ${ws.runId}\n`,
      );
      const deadline = Date.now() + options.timeoutMs;
      while (Date.now() < deadline) {
        const text = await readFile(join(dir, `${name}.answer.json`), "utf8").catch(() => undefined);
        const parsed = text === undefined ? undefined : AnswerFileSchema.safeParse(JSON.parse(text));
        if (parsed?.success) {
          answer = {
            outcome: parsed.data.outcome,
            by: parsed.data.by,
            at: parsed.data.at,
            ...(parsed.data.note ? { note: parsed.data.note } : {}),
            ...(parsed.data.attachment ? { attachment: await readAttachment(parsed.data.attachment) } : {}),
          };
          break;
        }
        await sleep(options.pollMs ?? 1000);
      }
      await rm(join(dir, `${name}.pending.json`), { force: true });
    }
    if (answer)
      events.emit("run", { kind: "user", name: answer.by }, "manual.answered", {
        caseId: request.caseId,
        stepId: request.stepId,
        outcome: answer.outcome,
      });
    else events.emit("run", system, "manual.timeout", { caseId: request.caseId, stepId: request.stepId });
    return answer;
  };
}

/**
 * `qajitsu answer <TICKET> <TC> <S> --passed|--failed`: answers a manual step a running `qj run` waits for in CI or
 * another terminal (REQ-EXEC-11/AC2). Only a waiting step can be answered; the person is recorded with the answer.
 *
 * @returns 0 answered, 3 errors (no waiting step, both or neither outcome).
 */
export async function runAnswer(
  rawKey: string,
  caseId: string,
  stepId: string,
  options: {
    readonly run?: string | undefined;
    readonly passed?: boolean | undefined;
    readonly failed?: boolean | undefined;
    readonly note?: string | undefined;
    readonly file?: string | undefined;
  },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
  user: string,
): Promise<number> {
  const masker = createMasker();
  try {
    if (options.passed === options.failed)
      throw new ConfigError("ANSWER_OUTCOME_REQUIRED", "Give exactly one of --passed or --failed.", {});
    if (!/^TC-\d{2,4}$/.test(caseId) || !/^S\d{1,3}$/.test(stepId))
      throw new ConfigError("ANSWER_STEP_INVALID", "Expected a case like TC-01 and a step like S2.", {});
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const dir = session.ws.path("manual");
    const name = fileBase({ caseId, stepId });
    if (!(await stat(join(dir, `${name}.pending.json`)).catch(() => undefined)))
      throw new ConfigError(
        "NO_PENDING_STEP",
        `${caseId} ${stepId} of run ${session.ws.runId} is not waiting for an answer.`,
        {},
      );
    const file = options.file === undefined ? undefined : resolve(io.cwd, options.file);
    const answer = AnswerFileSchema.parse({
      outcome: options.passed === true ? "passed" : "failed",
      by: user,
      at: ports.now().toISOString(),
      ...(options.note ? { note: options.note } : {}),
      ...(file ? { attachment: file } : {}),
    });
    const target = join(dir, `${name}.answer.json`);
    await writeFile(`${target}.tmp`, `${JSON.stringify(answer, null, 2)}\n`);
    await rename(`${target}.tmp`, target);
    io.write(`Answered ${caseId} ${stepId}: ${answer.outcome} (by ${user}).\n`);
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
