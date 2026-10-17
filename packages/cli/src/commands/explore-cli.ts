import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createLocalEvidenceStore } from "@qajitsu/adapter-evidence-local";
import { buildChangeContext, createUsageTracker, runCliExplorer } from "@qajitsu/agents";
import {
  CliExploreSessionSchema,
  ConfigError,
  QajitsuError,
  acquireRunLock,
  type CliExploreSession,
  type CliLeftovers,
  type EvidenceStore,
} from "@qajitsu/core";
import { renderCliExploreHtml, renderCliExploreMarkdown } from "@qajitsu/report";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { codeIndexCache, openSession, type ModelPorts } from "../session.js";
import {
  cleanUpLeftovers,
  createSandbox,
  findLeftovers,
  fromBase,
  removeSandbox,
  sandboxEnv,
  startAllowlistProxy,
  startCommand,
  type CliSandbox,
  type ToolProbe,
} from "./cli-sandbox.js";
import { createCliExploreTools, type CliExploreRecorder } from "./explore-cli-tools.js";
import { nextSessionId, numberOption } from "./explore.js";
import type { CommandIO } from "./fetch.js";

const SYSTEM = { kind: "system", name: "orchestrator" } as const;

/** Options of `qajitsu explore --cli`. */
export interface CliExploreOptions {
  readonly run?: string | undefined;
  readonly goal?: string | undefined;
  /** Name of the tool in `explore.cli` of `.qa/qa.project.yaml`. */
  readonly cli: string;
  readonly timeBox?: string | undefined;
  readonly maxSteps?: string | undefined;
}

/** Ports of a command-line session: the probe for processes and containers can be replaced in tests. */
export interface CliExplorePorts {
  readonly cliProbe?: ToolProbe;
}

/** Runs setup or teardown commands in the sandbox; their output is kept as evidence. */
async function runCommands(
  commands: readonly (
    readonly string[] | { readonly command: readonly string[]; readonly ok_exit_codes: readonly number[] }
  )[],
  kind: "setup" | "teardown",
  ctx: {
    readonly qaDir: string;
    readonly sandbox: CliSandbox;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly store: EvidenceStore;
    readonly mask: (text: string) => string;
  },
): Promise<string | undefined> {
  for (const [i, entry] of commands.entries()) {
    const cmd = "command" in entry ? entry.command : entry;
    const ok = "command" in entry ? entry.ok_exit_codes : [0];
    const [program = "", ...args] = cmd;
    const c = startCommand({
      program: fromBase(ctx.qaDir, program),
      baseArgs: args.map((a) => fromBase(ctx.qaDir, a)),
      args: [],
      cwd: ctx.sandbox.work,
      env: ctx.env,
      timeoutMs: ctx.timeoutMs,
    });
    const end = await c.wait(ctx.timeoutMs + 6000);
    await ctx.store.put(
      { path: `${kind}-${String(i + 1)}.txt`, caseId: "explore", stepId: kind, kind: "log" },
      new TextEncoder().encode(ctx.mask(`$ ${cmd.join(" ")}\n${c.allOutput()}`)),
    );
    if (end?.exitCode === undefined || !ok.includes(end.exitCode))
      return `${kind} command ${String(i + 1)} (${cmd[0] ?? ""}) ${end === undefined || end.timedOut ? "timed out" : `ended with ${end.exitCode !== undefined ? `exit code ${String(end.exitCode)}` : (end.endedBy ?? "an error")}`}`;
  }
  return undefined;
}

/**
 * `qajitsu explore <TICKET> --cli <tool> --goal <text>`: an exploratory session of a command-line tool
 * (REQ-EXEC-24). The tool runs in a throwaway sandbox made from its fixture, with its own HOME, only the configured
 * variables and an allowlist proxy; the explorer agent asks for commands and the trusted parent runs them with
 * argument arrays, recording output, exit codes and changed files as evidence. At the end, also after a time-out or
 * an error, the teardown runs and everything left is stopped and removed. The session produces observations and a
 * review report, never statuses.
 *
 * @returns 0 when the session ran (whatever it observed), 3 on errors.
 */
export async function runCliExplore(
  rawKey: string,
  options: CliExploreOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & CliExplorePorts,
): Promise<number> {
  const masker = createMasker();
  let release: (() => Promise<void>) | undefined;
  try {
    const goal = (options.goal ?? "").trim();
    if (goal === "")
      throw new ConfigError(
        "OPTION_INVALID",
        '--goal is required: say what to explore, e.g. --goal "env up and Ctrl+C".',
        {},
      );
    const minutes = numberOption(options.timeBox, 10, "--time-box", 240);
    const maxSteps = Math.floor(numberOption(options.maxSteps, 40, "--max-steps", 1000));
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const { ws, events, project } = session;
    // REQ-EXEC-24/AC7: only a tool described in the project's configuration.
    const tool = project.config.explore.cli[options.cli];
    if (!tool) {
      const known = Object.keys(project.config.explore.cli);
      throw new ConfigError(
        "CLI_TOOL_UNKNOWN",
        `No tool '${options.cli}' in explore.cli of .qa/qa.project.yaml${known.length > 0 ? ` (configured: ${known.join(", ")})` : "; describe it there first"}.`,
        { tool: options.cli },
      );
    }
    if (!ws.record.checkpoints.some((c) => c.stage === "fetch"))
      throw new ConfigError(
        "RUN_NOT_FETCHED",
        `Run ${ws.runId} has no fetched context; run 'qajitsu fetch' first.`,
        {},
      );
    release = await acquireRunLock(ws.path("run.lock"));
    const qaDir = project.qaDir;
    const [program = "", ...fixedArgs] = tool.command;
    const configured: Record<string, string> = {};
    const sandbox = await createSandbox(tool.fixture ? resolve(qaDir, tool.fixture) : undefined);
    const refusedHosts: string[] = [];
    let proxy: Awaited<ReturnType<typeof startAllowlistProxy>> | undefined;
    let recorder: CliExploreRecorder | undefined;
    try {
      for (const [name, entry] of Object.entries(tool.env)) {
        const value =
          "secret" in entry
            ? await session.resolveSecret(entry.secret)
            : entry.value.replaceAll("{{sandbox}}", sandbox.root).replaceAll("{{home}}", homedir());
        if ("secret" in entry) masker.register(value);
        configured[name] = value;
      }
      proxy = await startAllowlistProxy(tool.allowlist, (h) => {
        if (!refusedHosts.includes(h) && refusedHosts.length < 200) refusedHosts.push(h);
      });
      const env = sandboxEnv(sandbox, proxy.url, configured);
      const id = await nextSessionId(session);
      await mkdir(ws.path("explore", id), { recursive: true });
      const store = createLocalEvidenceStore(ws.path("explore", id, "evidence"));
      const timeoutMs = tool.timeout_s * 1000;
      const mask = (t: string): string => masker.maskText(t);
      const startedAt = ports.now().toISOString();
      events.emit("explore", SYSTEM, "explore.start", {
        session: id,
        goal,
        cli: options.cli,
        sandbox: sandbox.root,
        minutes,
        maxSteps,
      });
      io.write(
        `Exploratory session ${id} of ${options.cli} in a sandbox: ${String(minutes)} min, ${String(maxSteps)} actions\n`,
      );
      const shared = { qaDir, sandbox, env, timeoutMs, store, mask };
      let endReason: CliExploreSession["endReason"] = "finished";
      let summary = "";
      let error = await runCommands(tool.setup, "setup", shared);
      if (error !== undefined) endReason = "error";
      let modelId = "";
      recorder = createCliExploreTools({
        program: fromBase(qaDir, program),
        baseArgs: fixedArgs.map((a) => fromBase(qaDir, a)),
        sandbox,
        env,
        timeoutMs,
        store,
        mask,
        events,
        maxSteps,
        now: ports.now,
        ...(ports.cliProbe ? { probe: ports.cliProbe } : {}),
      });
      // REQ-EXEC-15/AC5: the time box is a timer in code, not a request to the model.
      const timeBox = new AbortController();
      const timer = setTimeout(() => {
        timeBox.abort();
      }, minutes * 60_000);
      if (error === undefined)
        try {
          modelId = (await session.models.forRole("explorer")).id;
          const usage = createUsageTracker({
            events,
            budget: project.config.models.token_budget,
            alreadyUsed: Number(ws.record.data["tokens"] ?? 0),
          });
          const result = await runCliExplorer(
            {
              ws,
              models: session.models,
              events,
              usage,
              now: ports.now,
              maskJson: (v: unknown) => masker.maskJson(v),
              maskText: mask,
            },
            {
              goal,
              tool: { name: options.cli, command: tool.command.join(" "), description: tool.description },
              context: await buildChangeContext(ws, [], { indexCache: codeIndexCache(project) }),
              tools: recorder.tools,
              maxSteps: maxSteps * 2 + 10,
              signal: timeBox.signal,
            },
          );
          summary = mask(result.summary);
          if (recorder.exhausted()) endReason = "step-budget";
          await ws.update({ data: { ...ws.record.data, tokens: usage.total } });
        } catch (e) {
          if (timeBox.signal.aborted) endReason = "time-box";
          else if (recorder.exhausted()) endReason = "step-budget";
          else {
            endReason = "error";
            error = mask((e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "").slice(0, 2000);
          }
        } finally {
          clearTimeout(timer);
        }
      else clearTimeout(timer);
      // REQ-EXEC-24/AC5: what was left running, then the teardown, then everything still left is stopped.
      const found = await findLeftovers(sandbox, recorder.background, ports.cliProbe);
      const leftovers: CliLeftovers = {
        processes: found.processes.map(mask),
        containers: found.containers.map(mask),
      };
      const teardownError = await runCommands(tool.teardown, "teardown", shared);
      const stopped = await cleanUpLeftovers(sandbox, recorder.background, ports.cliProbe);
      const cleaned: CliLeftovers = {
        processes: stopped.processes.map(mask),
        containers: stopped.containers.map(mask),
      };
      const record = CliExploreSessionSchema.parse({
        schema: 1,
        kind: "cli",
        id,
        ticket: ws.ticket,
        run: ws.runId,
        goal: mask(goal),
        tool: { name: options.cli, command: tool.command.map(mask) },
        model: modelId,
        startedAt,
        endedAt: ports.now().toISOString(),
        endReason,
        ...(error !== undefined || teardownError !== undefined
          ? { error: [error, teardownError].filter(Boolean).join("; ") }
          : {}),
        budget: { minutes, steps: maxSteps },
        summary,
        actions: recorder.actions,
        observations: recorder.observations,
        leftovers,
        cleaned,
        refusedHosts,
      });
      const manifest = await store.manifest();
      await writeFile(ws.path("explore", id, "session.json"), `${JSON.stringify(record, null, 2)}\n`, {
        flag: "wx",
      });
      await writeFile(ws.path("explore", id, "report.md"), renderCliExploreMarkdown(record, manifest));
      await writeFile(ws.path("explore", id, "report.html"), renderCliExploreHtml(record, manifest));
      events.emit("explore", SYSTEM, "explore.end", {
        session: id,
        endReason,
        actions: record.actions.length,
        observations: record.observations.length,
        leftovers: record.leftovers.processes.length + record.leftovers.containers.length,
      });
      io.write(
        [
          `Session ${id} ended: ${endReason}${record.error ? ` (${record.error})` : ""}; ${String(record.actions.length)} actions, ${String(record.observations.length)} observation(s).`,
          ...record.observations.map((o) => `  ${o.id} [${o.severity}] ${o.title}`),
          ...(record.leftovers.processes.length + record.leftovers.containers.length > 0
            ? [
                `Left running when the agent finished (stopped by the clean-up): ${String(record.leftovers.processes.length)} process(es), ${String(record.leftovers.containers.length)} container(s).`,
              ]
            : []),
          `Report: ${ws.path("explore", id, "report.html")}`,
          record.observations.length > 0
            ? `Turn an observation into a regression test proposal: qajitsu explore promote ${ws.ticket} --run ${ws.runId} --session ${id} --observation O1`
            : "",
          "",
        ]
          .filter((l, i, all) => l !== "" || i === all.length - 1)
          .join("\n"),
      );
      return 0;
    } finally {
      // Whatever happened above, nothing of the session stays running or on disk (REQ-EXEC-24/AC5).
      if (recorder)
        await cleanUpLeftovers(sandbox, recorder.background, ports.cliProbe).catch(() => undefined);
      await proxy?.close().catch(() => undefined);
      await removeSandbox(sandbox).catch(() => undefined);
    }
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  } finally {
    await release?.();
  }
}

/**
 * Turns an observation of a command-line session into a regression test proposal (REQ-EXEC-24/AC6):
 * `explore/<session>/promotions/<observation>.md` with the commands that reproduce it, what happened, what was
 * expected, and the steps as JSON for a test of the tool's own suite or a later CLI runner. Written by code from the
 * recorded session; nothing runs.
 *
 * @param record - The validated command-line session.
 * @param observationId - Observation to promote.
 * @param dir - The session's folder.
 * @returns The proposal's path.
 * @throws {ConfigError} `OBSERVATION_NOT_FOUND`.
 */
export async function writeCliPromotion(
  record: CliExploreSession,
  observationId: string,
  dir: string,
): Promise<string> {
  const observation = record.observations.find((o) => o.id === observationId);
  if (!observation)
    throw new ConfigError(
      "OBSERVATION_NOT_FOUND",
      `Session ${record.id} has no observation ${observationId}.`,
      {
        available: record.observations.map((o) => o.id),
      },
    );
  const byId = new Map(record.actions.map((a) => [a.id, a]));
  const steps = observation.steps.flatMap((id) => {
    const a = byId.get(id);
    return a
      ? [
          {
            action: a.action,
            ...(a.args.length > 0 ? { args: a.args } : {}),
            ...(a.background ? { background: a.background } : {}),
            ...(a.input ? { input: a.input } : {}),
            ...(a.signal ? { signal: a.signal } : {}),
            ...(a.path ? { path: a.path } : {}),
            observed: {
              ...(a.exitCode !== undefined ? { exitCode: a.exitCode } : {}),
              ...(a.endedBy ? { endedBy: a.endedBy } : {}),
              running: a.running,
              timedOut: a.timedOut,
              ...(a.output ? { output: `evidence/${a.output}` } : {}),
            },
          },
        ]
      : [];
  });
  const tool = record.tool.name;
  const text = [
    `# Regression test proposal: ${observation.title}`,
    "",
    `From exploratory session ${record.id} (${observation.id}) of \`${tool}\` for ${record.ticket}, run ${record.run}.`,
    `${observation.kind}, severity ${observation.severity}. A proposal for a person: nothing runs until someone adds it to a test suite or an approved plan.`,
    "",
    observation.description,
    "",
    "## Reproduce in a fresh sandbox of the tool's fixture",
    "",
    ...observation.steps.map((id, i) => {
      const a = byId.get(id);
      if (!a) return `${String(i + 1)}. ${id} (not recorded)`;
      const command =
        a.action === "run" || a.action === "start"
          ? `\`${[tool, ...a.args].join(" ")}\`${a.action === "start" ? " in the background" : ""}${a.input ? ` answering ${a.input.map((l) => `"${l}"`).join(", ")}` : ""}`
          : a.action === "send"
            ? `type "${(a.input ?? []).join(" ")}" into ${a.background ?? "the background command"}`
            : a.action === "signal"
              ? `send ${a.signal ?? "SIGINT"} to ${a.background ?? "the background command"}`
              : a.action === "wait"
                ? `wait for ${a.background ?? "the background command"}`
                : a.action === "leftovers"
                  ? "list processes and containers still running"
                  : `${a.action} ${a.path ?? "."}`;
      const seen = a.running
        ? "still running"
        : a.timedOut
          ? "stopped by the timeout"
          : a.exitCode !== undefined
            ? `exit code ${String(a.exitCode)}`
            : (a.endedBy ?? "done");
      return `${String(i + 1)}. ${command} → observed: ${seen}${a.output ? ` ([output](../evidence/${a.output}))` : ""}`;
    }),
    "",
    "## Expected",
    "",
    observation.expected || "_(not stated: decide what the tool should do)_",
    "",
    "## Observed",
    "",
    observation.actual || "_(see the outputs above)_",
    "",
    "## Steps as data",
    "",
    "```json",
    JSON.stringify({ tool, steps }, null, 2),
    "```",
    "",
  ].join("\n");
  await mkdir(resolve(dir, "promotions"), { recursive: true });
  const file = resolve(dir, "promotions", `${observation.id}.md`);
  await writeFile(file, text);
  return file;
}
