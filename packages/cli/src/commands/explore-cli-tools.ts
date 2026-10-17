import { untrusted, type AgentTool } from "@qajitsu/agents";
import type { CliAction, EventLog, EvidenceStore, Observation } from "@qajitsu/core";
import { readdir } from "node:fs/promises";
import { relative, sep } from "node:path";
import { z } from "zod";
import {
  argOutsideSandbox,
  changedFiles,
  findLeftovers,
  insideSandbox,
  readSandboxFile,
  secretFile,
  snapshotFiles,
  startCommand,
  type CliSandbox,
  type RunningCommand,
  type ToolProbe,
} from "./cli-sandbox.js";
import type { CliTerminal } from "./cli-terminal.js";
import { createObservationTool } from "./observation-tool.js";
import { oneAtATime } from "./one-at-a-time.js";

const ORCHESTRATOR = { kind: "system", name: "orchestrator" } as const;
/** Output the agent sees per action; the evidence keeps all of it. */
const SHOWN = 4000;
const Args = z.array(z.string().max(1000)).max(100);

/** What the command-line tools record; read by the command when the session ends. */
export interface CliExploreRecorder {
  readonly tools: readonly AgentTool[];
  readonly actions: readonly CliAction[];
  readonly observations: readonly Observation[];
  /** Background commands of the session (`B1`, ...), the ids the agent uses. */
  readonly background: readonly { readonly id: string; readonly command: RunningCommand }[];
  /** Every command the session started, background or not, for the clean-up (REQ-EXEC-24/AC5). */
  readonly commands: () => readonly { readonly id: string; readonly command: RunningCommand }[];
  /** True once the agent asked for an action beyond the step budget (REQ-EXEC-15/AC5). */
  readonly exhausted: () => boolean;
}

/** The last characters of an output, so the agent sees how a command ended. */
const tail = (text: string): string =>
  text.length > SHOWN ? `… (${String(text.length - SHOWN)} earlier characters)\n${text.slice(-SHOWN)}` : text;

/**
 * Builds the tools of a command-line exploratory session (REQ-EXEC-24). The agent only asks: the trusted parent runs
 * the configured program with an argument array in the sandbox, stores the masked output in the session's evidence
 * (manifest with SHA-256), lists the files the action changed and journals it before the agent sees the result. Files
 * are read only inside the sandbox; the step budget is counted here, in code.
 *
 * @param ctx - The tool's program and fixed arguments, sandbox, environment, timeout, evidence, masking, journal,
 *   budget, clock, the probe for left processes and containers, and the live terminal with its pace.
 */
export function createCliExploreTools(ctx: {
  readonly program: string;
  readonly baseArgs: readonly string[];
  readonly sandbox: CliSandbox;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly store: EvidenceStore;
  readonly mask: (text: string) => string;
  readonly events: EventLog;
  readonly maxSteps: number;
  readonly now: () => Date;
  readonly probe?: ToolProbe;
  /** Live view and recording of the session's terminal (REQ-EXEC-24/AC9+AC11). */
  readonly terminal?: CliTerminal;
  /** Name the tool is shown with, e.g. `qj`. */
  readonly display?: string;
  /** Wait before every command, typed line and signal (REQ-EXEC-24/AC10). */
  readonly slowMoMs?: number;
  readonly pause?: (ms: number) => Promise<void>;
}): CliExploreRecorder {
  const actions: CliAction[] = [];
  const observations: Observation[] = [];
  const background: { id: string; command: RunningCommand }[] = [];
  const foreground: { id: string; command: RunningCommand }[] = [];
  /**
   * New output of a background command for the agent and the evidence (security review M1): the whole output is
   * masked and only the new part handed out, up to its last complete line while the command runs, so a secret
   * printed across two reads is still masked.
   */
  const handedOut = new Map<RunningCommand, number>();
  const newOutput = (c: RunningCommand): string => {
    const masked = ctx.mask(c.allOutput());
    const from = handedOut.get(c) ?? 0;
    const to = c.ended() ? masked.length : masked.lastIndexOf("\n") + 1;
    if (to <= from) return "";
    handedOut.set(c, to);
    return masked.slice(from, to);
  };
  /** Resolves with `undefined` as soon as the session is aborted (time box, Ctrl+C). */
  const untilAborted = <T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> =>
    signal === undefined
      ? work
      : signal.aborted
        ? Promise.resolve(undefined)
        : Promise.race([
            work,
            new Promise<undefined>((done) => {
              signal.addEventListener(
                "abort",
                () => {
                  done(undefined);
                },
                { once: true },
              );
            }),
          ]);
  let exhausted = false;

  const refuse = (tool: string, reason: string): string => {
    ctx.events.emit("explore", ORCHESTRATOR, "explore.refused", { tool, reason });
    return `REFUSED: ${reason}`;
  };
  /** REQ-EXEC-24/AC2: a path outside the sandbox in the arguments is refused before the tool runs. */
  const escaping = (tool: string, args: readonly string[]): string | undefined => {
    const out = args.filter((a) => argOutsideSandbox(ctx.sandbox, a));
    return out.length > 0
      ? refuse(
          tool,
          `arguments may not name paths outside the sandbox (${out.map((a) => a.slice(0, 80)).join(", ")}); use paths inside the working folder`,
        )
      : undefined;
  };
  const nextId = (): string | undefined => {
    if (actions.length >= ctx.maxSteps) {
      exhausted = true;
      return undefined;
    }
    return `A${String(actions.length + 1).padStart(2, "0")}`;
  };
  const pause = ctx.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const shown = ctx.display ?? "tool";
  /** Shows an action starting; commands, typed lines and signals wait for `--slow-mo` first. */
  const begin = async (id: string, label: string, paced: boolean): Promise<void> => {
    if (paced && ctx.slowMoMs) await pause(ctx.slowMoMs);
    ctx.terminal?.begin(id, label);
  };
  const BUDGET =
    "STEP BUDGET USED: stop exploring now and answer with the JSON answer: the checklist, findings and summary.";

  /** Records an action with its output as evidence and the files it changed; returns the line the agent reads. */
  const record = async (
    id: string,
    action: CliAction["action"],
    fields: Partial<CliAction>,
    output: string,
    before: Map<string, string> | undefined,
    started: number,
  ): Promise<string> => {
    const masked = ctx.mask(output);
    // Commands stream their output live; what an inspection found is shown when it ends.
    if (["read", "list", "leftovers"].includes(action) && masked !== "") ctx.terminal?.output(`${masked}\n`);
    let path: string | undefined;
    if (masked !== "") {
      const stored = await ctx.store.put(
        { path: `${id}-output.txt`, caseId: "explore", stepId: id, kind: "log" },
        new TextEncoder().encode(masked),
      );
      path = stored.path;
    }
    const changed = before ? changedFiles(before, await snapshotFiles(ctx.sandbox.root)) : [];
    const entry: CliAction = {
      id,
      action,
      args: [],
      timedOut: false,
      running: false,
      changed,
      ...fields,
      ok: fields.ok ?? true,
      durationMs: Math.max(0, ctx.now().getTime() - started),
      ...(path ? { output: path } : {}),
      at: ctx.now().toISOString(),
    };
    actions.push(entry);
    ctx.events.emit("explore", ORCHESTRATOR, "explore.action", {
      id,
      action,
      args: entry.args,
      ok: entry.ok,
      ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
      ...(entry.background ? { background: entry.background } : {}),
    });
    const status = entry.running
      ? "still running"
      : entry.timedOut
        ? "stopped by the timeout"
        : entry.exitCode !== undefined
          ? `exit code ${String(entry.exitCode)}`
          : entry.endedBy
            ? `ended by ${entry.endedBy}`
            : entry.ok
              ? "done"
              : `failed: ${entry.error ?? ""}`;
    ctx.terminal?.end(id, `${status}${entry.background ? ` (${entry.background})` : ""}`);
    return [
      `${id} ${status}${entry.background ? ` (${entry.background})` : ""}.`,
      changed.length > 0 ? untrusted(`${id} changed files`, changed.slice(0, 30).join("\n")) : "",
      masked !== "" ? untrusted(`${id} output`, tail(masked)) : "(no output)",
    ]
      .filter(Boolean)
      .join("\n");
  };

  const command = (
    args: readonly string[],
    input: readonly string[] | undefined,
    interactive: boolean,
    from?: string,
  ) =>
    startCommand({
      onOutput: (text) => ctx.terminal?.output(text, from),
      program: ctx.program,
      baseArgs: ctx.baseArgs,
      args,
      cwd: ctx.sandbox.work,
      env: ctx.env,
      timeoutMs: ctx.timeoutMs,
      input,
      interactive,
    });
  const line = (args: readonly string[]): string => [shown, ...args].join(" ");
  const findBackground = (id: string) => background.find((b) => b.id === id);
  const endFields = (end: {
    exitCode?: number | undefined;
    endedBy?: string | undefined;
    timedOut: boolean;
  }) => ({
    ...(end.exitCode !== undefined ? { exitCode: end.exitCode } : {}),
    ...(end.endedBy !== undefined ? { endedBy: end.endedBy } : {}),
    timedOut: end.timedOut,
    ok: end.exitCode === 0 && !end.timedOut,
  });

  const tools: AgentTool[] = [
    {
      name: "cli_run",
      description:
        'Run the tool with these arguments (no shell) and wait until it ends. `input` lines are typed into its prompts, e.g. ["yes"].',
      inputSchema: z.object({ args: Args, input: z.array(z.string().max(1000)).max(50).optional() }),
      async execute(input, signal) {
        const id = nextId();
        if (!id) return BUDGET;
        const args = (input["args"] as unknown[]).map(String);
        const refused = escaping("cli_run", args);
        if (refused) return refused;
        const lines = Array.isArray(input["input"]) ? (input["input"] as unknown[]).map(String) : undefined;
        const before = await snapshotFiles(ctx.sandbox.root);
        await begin(id, line(args), true);
        for (const l of lines ?? []) ctx.terminal?.echo(`> ${l}`);
        const started = ctx.now().getTime();
        const c = command(args, lines, false);
        foreground.push({ id, command: c });
        // The time box or Ctrl+C stops the command at once, not after its own timeout.
        const stop = (): void => {
          void c.kill();
        };
        signal?.addEventListener("abort", stop, { once: true });
        const end = (await c.wait(ctx.timeoutMs + 6000).finally(() => {
          signal?.removeEventListener("abort", stop);
        })) ?? { timedOut: true };
        return record(
          id,
          "run",
          {
            args: args.map(ctx.mask),
            ...(lines ? { input: lines.map(ctx.mask) } : {}),
            ...endFields(end),
          },
          c.allOutput(),
          before,
          started,
        );
      },
    },
    {
      name: "cli_start",
      description:
        "Start the tool in the background (e.g. a command that waits for Ctrl+C); returns its id, e.g. B1, and its first output.",
      inputSchema: z.object({ args: Args }),
      async execute(input) {
        const id = nextId();
        if (!id) return BUDGET;
        const args = (input["args"] as unknown[]).map(String);
        const refused = escaping("cli_start", args);
        if (refused) return refused;
        const before = await snapshotFiles(ctx.sandbox.root);
        const bid = `B${String(background.length + 1)}`;
        await begin(id, `${line(args)} &  (${bid})`, true);
        const started = ctx.now().getTime();
        const c = command(args, undefined, true, bid);
        background.push({ id: bid, command: c });
        const end = await c.wait(3000);
        return record(
          id,
          "start",
          {
            args: args.map(ctx.mask),
            background: bid,
            ...(end ? endFields(end) : { running: true, ok: true }),
          },
          newOutput(c),
          before,
          started,
        );
      },
    },
    {
      name: "cli_send",
      description: "Type a line into a background command, e.g. an answer to its prompt.",
      inputSchema: z.object({ background: z.string(), line: z.string().max(1000) }),
      async execute(input) {
        const b = findBackground(String(input["background"]));
        if (!b) return refuse("cli_send", "unknown background command; use the id cli_start returned");
        const id = nextId();
        if (!id) return BUDGET;
        const typed = String(input["line"]);
        await begin(id, `(type into ${b.id})`, true);
        ctx.terminal?.echo(`> ${typed}`);
        const started = ctx.now().getTime();
        b.command.send(typed);
        const end = await b.command.wait(1500);
        return record(
          id,
          "send",
          {
            background: b.id,
            input: [ctx.mask(typed)],
            ...(end ? endFields(end) : { running: true, ok: true }),
          },
          newOutput(b.command),
          undefined,
          started,
        );
      },
    },
    {
      name: "cli_signal",
      description:
        "Send Ctrl+C (SIGINT) or SIGTERM to a background command and wait up to `seconds` for it to end.",
      inputSchema: z.object({
        background: z.string(),
        signal: z.enum(["SIGINT", "SIGTERM"]).default("SIGINT"),
        seconds: z.number().min(0).max(120).default(20),
      }),
      async execute(input, aborted) {
        const b = findBackground(String(input["background"]));
        if (!b) return refuse("cli_signal", "unknown background command; use the id cli_start returned");
        const id = nextId();
        if (!id) return BUDGET;
        const sig = input["signal"] === "SIGTERM" ? "SIGTERM" : "SIGINT";
        const seconds = typeof input["seconds"] === "number" ? input["seconds"] : 20;
        const before = await snapshotFiles(ctx.sandbox.root);
        await begin(id, `(${sig === "SIGINT" ? "Ctrl+C" : "SIGTERM"} → ${b.id})`, true);
        const started = ctx.now().getTime();
        b.command.signal(sig);
        const end = await untilAborted(b.command.wait(seconds * 1000), aborted);
        return record(
          id,
          "signal",
          {
            background: b.id,
            signal: sig,
            ...(end ? endFields(end) : { running: true, ok: false, error: "still running" }),
          },
          newOutput(b.command),
          before,
          started,
        );
      },
    },
    {
      name: "cli_wait",
      description:
        "Wait up to `seconds` for a background command, then show its new output and whether it ended.",
      inputSchema: z.object({ background: z.string(), seconds: z.number().min(0).max(300).default(10) }),
      async execute(input, signal) {
        const b = findBackground(String(input["background"]));
        if (!b) return refuse("cli_wait", "unknown background command; use the id cli_start returned");
        const id = nextId();
        if (!id) return BUDGET;
        const seconds = typeof input["seconds"] === "number" ? input["seconds"] : 10;
        const before = await snapshotFiles(ctx.sandbox.root);
        await begin(id, `(wait for ${b.id}, up to ${String(seconds)} s)`, false);
        const started = ctx.now().getTime();
        const end = await untilAborted(b.command.wait(Math.min(seconds * 1000, ctx.timeoutMs)), signal);
        return record(
          id,
          "wait",
          { background: b.id, ...(end ? endFields(end) : { running: true, ok: true }) },
          newOutput(b.command),
          before,
          started,
        );
      },
    },
    {
      name: "cli_read",
      description: "Read a file of the sandbox (relative to the working folder).",
      inputSchema: z.object({ path: z.string().max(1000) }),
      async execute(input) {
        const path = String(input["path"]);
        const real = await insideSandbox(ctx.sandbox, path);
        if (!real) return refuse("cli_read", "only existing files inside the sandbox can be read");
        if (real.split(sep).some(secretFile))
          return refuse("cli_read", "secrets files (.env, .env.*, .qa-runs) are never read");
        const id = nextId();
        if (!id) return BUDGET;
        await begin(id, `(read ${path})`, false);
        const started = ctx.now().getTime();
        const text = await readSandboxFile(real, ctx.mask).catch((e: unknown) => `cannot read: ${String(e)}`);
        return record(id, "read", { path: ctx.mask(path) }, text, undefined, started);
      },
    },
    {
      name: "cli_list",
      description:
        "List a folder of the sandbox (relative to the working folder; default: the working folder).",
      inputSchema: z.object({ path: z.string().max(1000).optional() }),
      async execute(input) {
        const path = typeof input["path"] === "string" ? input["path"] : ".";
        const real = await insideSandbox(ctx.sandbox, path);
        if (!real) return refuse("cli_list", "only existing folders inside the sandbox can be listed");
        const id = nextId();
        if (!id) return BUDGET;
        await begin(id, `(list ${path})`, false);
        const started = ctx.now().getTime();
        const entries = await readdir(real, { withFileTypes: true }).catch(() => []);
        const text = entries
          .slice(0, 300)
          .map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`)
          .join("\n");
        return record(
          id,
          "list",
          { path: ctx.mask(relative(ctx.sandbox.work, real) || ".") },
          text || "(empty)",
          undefined,
          started,
        );
      },
    },
    {
      name: "cli_leftovers",
      description:
        "List what the session left running: background commands, processes started in the sandbox and their containers.",
      inputSchema: z.object({}),
      async execute() {
        const id = nextId();
        if (!id) return BUDGET;
        await begin(id, "(what is left running)", false);
        const started = ctx.now().getTime();
        const found = await findLeftovers(ctx.sandbox, background, ctx.probe);
        const text = [
          `Processes (${String(found.processes.length)}):`,
          ...found.processes,
          `Containers (${String(found.containers.length)}):`,
          ...found.containers,
        ].join("\n");
        return record(id, "leftovers", {}, text, undefined, started);
      },
    },
    createObservationTool({
      knownIds: () => new Set(actions.map((a) => a.id)),
      observations,
      mask: ctx.mask,
      events: ctx.events,
    }),
  ];
  return {
    tools: oneAtATime(tools),
    actions,
    observations,
    background,
    commands: () => [...background, ...foreground],
    exhausted: () => exhausted,
  };
}
