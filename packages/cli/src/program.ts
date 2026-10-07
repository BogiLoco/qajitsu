import { existsSync } from "node:fs";
import { join } from "node:path";
import { QajitsuError, qajitsuHome, resolveProject, type ResolvedProject } from "@qajitsu/core";
import { Command } from "commander";
import type { RuntimePorts } from "./adapters.js";
import { formatProbes, probeModels } from "@qajitsu/agents";
import { runFetch } from "./commands/fetch.js";
import { runApprove, runPlan } from "./commands/plan.js";
import { runEvidence } from "./commands/evidence.js";
import { runEvidenceServe } from "./commands/viewer.js";
import { runLogs } from "./commands/logs.js";
import { runPublish } from "./commands/publish.js";
import { runPull } from "./commands/pull.js";
import { runRun, type RunPorts } from "./commands/run.js";
import { runTest } from "./commands/test-flow.js";
import { runFixCheck } from "./commands/fix-check.js";
import { runClean, runGc, runResume, runRuns, runWorkReset } from "./commands/runs.js";
import { runEnvCheck, runEnvRender, runEnvUp } from "./commands/env.js";
import {
  runProjectArchive,
  runProjectInit,
  runProjectRemove,
  runProjects,
  runUse,
} from "./commands/projects.js";
import { runNote, runResumable, runStatus } from "./commands/status.js";
import { runPromote, type PromoteOptions } from "./commands/promote.js";
import { runBug, type BugOptions } from "./commands/bug.js";
import { runAnswer } from "./commands/manual.js";
import { runBaselineAccept } from "./commands/baseline.js";
import { runProjectExport, runProjectImport } from "./commands/project-profile.js";
import {
  runKnowledgeAdd,
  runKnowledgeList,
  runKnowledgeReindex,
  runKnowledgeRemove,
  runKnowledgeReset,
  runKnowledgeSearch,
  runKnowledgeSync,
} from "./commands/knowledge.js";

interface KnowledgeAddOptions {
  include?: string[];
  exclude?: string[];
  tag?: string[];
  qaKnowledge?: boolean;
  yes?: boolean;
}
import { runExplore, runExplorePromote } from "./commands/explore.js";
import { runBench } from "./commands/bench.js";
import { runAuditVerify } from "./commands/audit.js";
import { runTelemetryExport } from "./commands/telemetry.js";
import { runMetrics } from "./commands/metrics.js";
import { runExport } from "./commands/export.js";
import { runMap } from "./commands/map.js";
import { runCiComment, runCiDetect, runCiPublishPlan } from "./commands/ci.js";
import { loadProject } from "./project.js";
import type { ModelPorts } from "./session.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { projectChecks } from "./doctor-project.js";

/** Output and environment ports, injected for tests. */
export interface ProgramIO {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly cwd: string;
  readonly nodeVersion: string;
  readonly setExitCode: (code: number) => void;
  /** Process ports for commands that touch adapters; required by `fetch` and later commands. */
  readonly ports?: RuntimePorts & ModelPorts & RunPorts;
  /** Interactive question; undefined when not attached to a terminal (CI). */
  readonly ask?: (question: string) => Promise<string>;
  /** Opens a file in `$EDITOR` (plan review, REQ-PLAN-04/AC1). */
  readonly openEditor?: (file: string) => Promise<void>;
  /** User name recorded as approver. */
  readonly user?: string;
  /** Opens a file with the system application (report, video). */
  readonly openFile?: (path: string) => Promise<void>;
  /** Opens a Playwright trace in Trace Viewer. */
  readonly openTrace?: (path: string) => Promise<void>;
  /** Compresses a video for upload (ffmpeg); resolves true on success (REQ-EVD-06/AC2). */
  readonly compressVideo?: (input: string, output: string) => Promise<boolean>;
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/**
 * Builds the `qajitsu` command (REQ-GEN-05). Only implemented commands are registered;
 * planned ones are listed in docs/requirements/generic.md.
 *
 * @param version - Version printed by `--version`.
 * @param io - Output and environment ports.
 */
export function createProgram(version: string, io: ProgramIO): Command {
  const program = new Command()
    .name("qajitsu")
    .description("Agentic QA: Jira ticket in, approved test plan, executed tests and evidence out.")
    .version(version)
    .option(
      "--project <slug>",
      "project to work in (default: QAJITSU_PROJECT, the ticket prefix, the active project)",
    )
    .configureOutput({ writeOut: io.write, writeErr: io.writeError })
    // Global options go before the command (`qj --project bank fetch BANK-1`), so `clean --project` is its own.
    .enablePositionalOptions()
    .showHelpAfterError();

  // ADR-0006, REQ-PRJ-03: the project of a command is resolved once, before it runs, never from the current folder.
  let resolved: ResolvedProject | undefined;
  let projectError: unknown;
  const PROJECT_FREE = new Set([
    "init",
    "use",
    "projects list",
    "projects current",
    "projects export",
    "projects import",
    "projects remove",
    "projects archive",
    "projects unarchive",
  ]);
  // These commands write machine-readable output to stdout; the project line goes to stderr.
  const MACHINE_OUTPUT = new Set(["ci detect", "metrics"]);
  program.hook("preAction", async (_root, action) => {
    const path: string[] = [];
    for (let c: Command | null = action; c && c !== program; c = c.parent) path.unshift(c.name());
    const name = path.join(" ");
    if (PROJECT_FREE.has(name) || !io.ports) return;
    const first = action.args[0];
    try {
      resolved = await resolveProject(qajitsuHome(io.ports.env, io.ports.home), {
        flag: program.opts<{ project?: string }>().project,
        env: io.ports.env["QAJITSU_PROJECT"],
        ticket: typeof first === "string" ? first : undefined,
      });
      // REQ-PRJ-03/AC4: every command names its project first.
      (MACHINE_OUTPUT.has(name) ? io.writeError : io.write)(`Project: ${resolved.slug} (${resolved.via})\n`);
    } catch (error) {
      projectError = error;
    }
  });
  const projectFailure = (): number => {
    const code = projectError instanceof QajitsuError ? ` [${projectError.code}]` : "";
    io.writeError(
      `Error${code}: ${projectError instanceof Error ? projectError.message : "unknown error"}\n`,
    );
    return 3;
  };

  const withPorts =
    (run: (ports: RuntimePorts & ModelPorts & RunPorts) => Promise<number>) => async (): Promise<void> => {
      if (!io.ports) {
        io.writeError("Runtime ports are not configured.\n");
        io.setExitCode(3);
        return;
      }
      if (projectError !== undefined || !resolved) {
        io.setExitCode(projectFailure());
        return;
      }
      io.setExitCode(await run({ ...io.ports, project: resolved }));
    };
  const commandIO = { write: io.write, writeError: io.writeError, cwd: io.cwd, ask: io.ask };
  const review = { user: io.user ?? "unknown", openEditor: io.openEditor };

  program
    .command("init")
    .description(
      "Register a project: its home under ~/.qajitsu and its .qa/ folder (linked, or created by detection)",
    )
    .argument("<slug>", "project name, e.g. bank or shop-web")
    .option("--qa-dir <path>", "the project's .qa/ folder (default: ./.qa)")
    .option("--jira-prefix <KEY>", "Jira key prefix of the project, e.g. BANK (repeatable)", collect, [])
    .option("--yes", "do not ask; use detected values and flags")
    .option("--force", "relink an existing project (runs and knowledge stay)")
    .option("--no-use", "do not make it the active project")
    .option("--jira-url <url>", "when creating .qa/: Jira base URL (empty: tickets from files)")
    .option("--project-key <key>", "when creating .qa/: Jira project key")
    .option("--env-url <url>", "when creating .qa/: URL of the test environment")
    .action(
      (
        slug: string,
        options: {
          qaDir?: string;
          jiraPrefix: string[];
          yes?: boolean;
          force?: boolean;
          use?: boolean;
          jiraUrl?: string;
          projectKey?: string;
          envUrl?: string;
        },
      ) => {
        if (!io.ports) return withPorts(() => Promise.resolve(3))();
        const ports = io.ports;
        return runProjectInit(slug, options, commandIO, ports).then((code) => {
          io.setExitCode(code);
        });
      },
    );

  program
    .command("use")
    .description("Make a project the active one and show its open work")
    .argument("<slug>", "project name")
    .action(async (slug: string) => {
      io.setExitCode(io.ports ? await runUse(slug, commandIO, io.ports) : 3);
    });

  const projects = program
    .command("projects")
    .description("List the registered projects or print the active one");
  projects
    .command("list")
    .description("Every project with readiness, ticket prefixes and open work")
    .option("--archived", "include archived projects")
    .action(async (options: { archived?: boolean }) => {
      io.setExitCode(
        io.ports ? await runProjects("list", commandIO, io.ports, options.archived === true) : 3,
      );
    });
  projects
    .command("remove")
    .description("Delete a project's home after confirmation; its .qa/ folder stays, run journals are kept")
    .argument("<slug>", "project name")
    .option("--dry-run", "only list what would be deleted and its size")
    .option("--yes", "do not ask for confirmation")
    .option("--delete-audit", "also delete the archived run journals")
    .action(async (slug: string, options: { dryRun?: boolean; yes?: boolean; deleteAudit?: boolean }) => {
      io.setExitCode(io.ports ? await runProjectRemove(slug, options, commandIO, io.ports) : 3);
    });
  projects
    .command("archive")
    .description("Hide a project from lists and ticket prefixes; nothing is deleted")
    .argument("<slug>", "project name")
    .action(async (slug: string) => {
      io.setExitCode(io.ports ? await runProjectArchive(slug, true, commandIO, io.ports) : 3);
    });
  projects
    .command("unarchive")
    .description("Show an archived project again")
    .argument("<slug>", "project name")
    .action(async (slug: string) => {
      io.setExitCode(io.ports ? await runProjectArchive(slug, false, commandIO, io.ports) : 3);
    });
  projects
    .command("export")
    .description(
      "Write the project profile, its .qa/ files and knowledge sources to one file (no index, no secrets)",
    )
    .argument("<slug>", "project name")
    .option("--out <file>", "where to write it (default: <project-home>/exports/<slug>.profile.yaml)")
    .action(async (slug: string, options: { out?: string }) => {
      io.setExitCode(io.ports ? await runProjectExport(slug, options, commandIO, io.ports) : 3);
    });
  projects
    .command("import")
    .description(
      "Recreate a project from an exported profile; rebuild its knowledge base with 'knowledge sync'",
    )
    .argument("<file>", "profile written by 'projects export'")
    .option("--qa-dir <path>", "where the project's .qa/ folder is or goes (default: the exported path)")
    .option("--slug <slug>", "register under another name")
    .option(
      "--map-path <old=new>",
      "rewrite a path prefix of .qa/ and knowledge sources (repeatable)",
      collect,
      [],
    )
    .option("--force", "replace an existing project with that name (runs and knowledge stay)")
    .action(
      async (
        file: string,
        options: { qaDir?: string; slug?: string; mapPath?: string[]; force?: boolean },
      ) => {
        io.setExitCode(io.ports ? await runProjectImport(file, options, commandIO, io.ports) : 3);
      },
    );
  projects
    .command("current")
    .description("Print the active project")
    .action(async () => {
      io.setExitCode(io.ports ? await runProjects("current", commandIO, io.ports) : 3);
    });

  const knowledge = program
    .command("knowledge")
    .description("The project's knowledge base: documents agents can search, with cited sources");
  knowledge
    .command("add")
    .description(
      "Add files and folders (recursive) to the knowledge base; only new or changed files are processed",
    )
    .argument("[paths...]", "files or folders")
    .option("--include <glob>", "only files matching this glob (repeatable)", collect, [])
    .option("--exclude <glob>", "skip files matching this glob (repeatable)", collect, [])
    .option("--tag <tag>", "tag the documents of this source (repeatable)", collect, [])
    .option("--qa-knowledge", "add the project's .qa/knowledge/ folder")
    .option("--yes", "confirm sending document text to a cloud embedding model")
    .action(async (paths: string[], options: KnowledgeAddOptions) => {
      await withPorts((ports) => runKnowledgeAdd(paths, options, commandIO, ports))();
    });
  knowledge
    .command("sync")
    .description("Re-process changed files, remove chunks of deleted files and add new files of every source")
    .option("--dry-run", "only show what would change")
    .option("--yes", "confirm sending document text to a cloud embedding model")
    .action(async (options: { dryRun?: boolean; yes?: boolean }) => {
      await withPorts((ports) => runKnowledgeSync(options, commandIO, ports))();
    });
  knowledge
    .command("remove")
    .description("Remove a source or one file from the knowledge base")
    .argument("<source-or-file>", "source name or file path")
    .action(async (target: string) => {
      await withPorts((ports) => runKnowledgeRemove(target, commandIO, ports))();
    });
  knowledge
    .command("reset")
    .description("Empty the knowledge base after confirmation")
    .option("--keep-sources", "keep the registered sources for a later sync")
    .option("--yes", "do not ask for confirmation")
    .action(async (options: { keepSources?: boolean; yes?: boolean }) => {
      await withPorts((ports) => runKnowledgeReset(options, commandIO, ports))();
    });
  knowledge
    .command("reindex")
    .description("Store every chunk again with the configured embedding model and retrieval mode")
    .option("--yes", "confirm sending document text to a cloud embedding model")
    .action(async (options: { yes?: boolean }) => {
      await withPorts((ports) => runKnowledgeReindex(options, commandIO, ports))();
    });
  knowledge
    .command("list")
    .description(
      "Sources with file and chunk counts, tags, last sync, embedding model, retrieval mode and size",
    )
    .action(withPorts((ports) => runKnowledgeList(commandIO, ports)));
  knowledge
    .command("search")
    .description("Print the ranked chunks agents would get for a query, with source, section and date")
    .argument("<query>", "search text")
    .option("--tag <tag>", "only documents with this tag (repeatable)", collect, [])
    .option("--limit <n>", "number of results (default 5)")
    .action(async (query: string, options: { tag?: string[]; limit?: string }) => {
      await withPorts((ports) => runKnowledgeSearch(query, options, commandIO, ports))();
    });

  program
    .command("doctor")
    .description("Check that this machine and project are ready for QAJitsu")
    .option("--models", "probe the configured model of every role (makes real model calls)")
    .option("--online", "check access to Jira and every code host (makes real requests)")
    .action(async (options: { models?: boolean; online?: boolean }) => {
      const checks = runDoctor({
        nodeVersion: io.nodeVersion,
        hasProjectConfig:
          resolved !== undefined && existsSync(join(resolved.record.qa_dir, "qa.project.yaml")),
      });
      if (projectError !== undefined)
        checks.push({
          name: "project",
          ok: false,
          detail: projectError instanceof Error ? projectError.message : "unknown error",
        });
      if (checks.every((c) => c.ok) && io.ports) {
        // REQ-GEN-03/AC2: secrets, Docker, Android/Appium and, with --online, Jira and code hosts.
        try {
          checks.push(
            ...(await projectChecks(
              await loadProject(io.cwd, resolved),
              { ...io.ports, ...(resolved ? { project: resolved } : {}) },
              {
                online: options.online === true,
              },
            )),
          );
        } catch (error) {
          checks.push({
            name: "project config",
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      io.write(`${formatDoctor(checks)}\n`);
      let ok = checks.every((c) => c.ok);
      if (options.models === true && io.ports) {
        try {
          const project = await loadProject(io.cwd, resolved);
          const { createModelRegistry } = await import("@qajitsu/models");
          const { createMasker } = await import("@qajitsu/steps");
          const { createCliSecretResolver } = await import("./adapters.js");
          const models = createModelRegistry({
            config: project.config.models,
            resolveSecret: createCliSecretResolver(project, io.ports, createMasker()),
            fetch: io.ports.fetch,
            ...(io.ports.extraModels ? { extra: io.ports.extraModels } : {}),
          });
          const probes = await probeModels(models, Object.keys(project.config.models.roles));
          io.write(`${formatProbes(probes)}\n`);
          ok = ok && probes.every((p) => p.reachable && p.missing.length === 0);
        } catch (error) {
          io.write(`✘ models: ${error instanceof Error ? error.message : String(error)}\n`);
          ok = false;
        }
      }
      io.setExitCode(ok ? 0 : 3);
    });

  program
    .command("plan")
    .description("Analyse the fetched change and write a test plan; review it interactively")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--revise <instruction>", "write a new plan version following this instruction")
    .option("--depth <depth>", "smoke (high-risk cases), standard (high and medium) or full (every case)")
    .action((ticket: string, options: { run?: string; revise?: string; depth?: string }) =>
      withPorts((ports) => runPlan(ticket, options, commandIO, ports, review))(),
    );

  program
    .command("approve")
    .description("Approve and freeze a plan version (SHA-256 recorded in run.json)")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--version <n>", "plan version (default: latest)")
    .option("--confirm-open-questions", "approve although the plan has open questions")
    .option("--approver <name>", "who approves (CI: the reviewer or the /qa approve author)")
    .option("--reuse-from <run>", "reuse the plan approved in this earlier run if the ticket did not change")
    .action(
      (
        ticket: string,
        options: {
          run?: string;
          version?: string;
          confirmOpenQuestions?: boolean;
          approver?: string;
          reuseFrom?: string;
        },
      ) => withPorts((ports) => runApprove(ticket, options, commandIO, ports, review))(),
    );

  program
    .command("fetch")
    .description(
      "Fetch a ticket, its PRs/MRs, diffs and repositories at the change's commit into a new run folder",
    )
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--pr <url>", "use this GitHub pull request (repeatable)", collect, [])
    .option("--mr <url>", "use this GitLab merge request (repeatable)", collect, [])
    .option("--ref <[repo=]ref>", "use this branch, tag or SHA (repeatable)", collect, [])
    .action((ticket: string, options: { pr: string[]; mr: string[]; ref: string[] }) =>
      withPorts((ports) => runFetch(ticket, options, commandIO, ports))(),
    );

  program
    .command("run")
    .description("Execute the approved plan against an environment; write results, evidence and reports")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option(
      "--env <profile|url>",
      "environment profile from .qa/envs or a URL (default: environments.default)",
    )
    .option(
      "--build",
      "build the application from the fetched worktrees (services and build in qa.project.yaml)",
    )
    .option("--keep", "with --build: keep containers and worktrees after the run")
    .option(
      "--set <service.VAR=value>",
      "with --build: override an overridable service variable (repeatable)",
      collect,
      [],
    )
    .option(
      "--fix-check",
      "with --build: verify a bug fix: cases marked reproduces must FAIL before the fix and PASS with it",
    )
    .action(
      (
        ticket: string,
        options: {
          run?: string;
          env?: string;
          build?: boolean;
          keep?: boolean;
          set: string[];
          fixCheck?: boolean;
        },
      ) => {
        const { fixCheck, ...runOptions } = options;
        return withPorts((ports) =>
          fixCheck === true
            ? runFixCheck(ticket, runOptions, commandIO, ports, review)
            : runRun(ticket, { ...runOptions, user: io.user }, commandIO, ports),
        )();
      },
    );

  program
    .command("test")
    .description("The whole flow in one command: fetch, plan with review, run and publish after the preview")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--pr <url>", "use this GitHub pull request (repeatable)", collect, [])
    .option("--mr <url>", "use this GitLab merge request (repeatable)", collect, [])
    .option("--ref <[repo=]ref>", "use this branch, tag or SHA (repeatable)", collect, [])
    .option(
      "--env <profile|url>",
      "environment profile from .qa/envs or a URL (default: environments.default)",
    )
    .option("--build", "build the application from the fetched worktrees")
    .option("--keep", "with --build: keep containers and worktrees after the run")
    .option(
      "--set <service.VAR=value>",
      "with --build: override an overridable service variable",
      collect,
      [],
    )
    .option("--dry-run", "stop after the run; do not publish")
    .action(
      (
        ticket: string,
        options: {
          pr: string[];
          mr: string[];
          ref: string[];
          env?: string;
          build?: boolean;
          keep?: boolean;
          set: string[];
          dryRun?: boolean;
        },
      ) =>
        withPorts((ports) =>
          runTest(ticket, options, commandIO, ports, { review, compressVideo: io.compressVideo }),
        )(),
    );

  const explore = program
    .command("explore")
    .description(
      "Exploratory session: an agent explores the app towards a goal; observations and a review report, no statuses",
    )
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--goal <text>", 'what to explore, e.g. "checkout around the terms change"')
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option(
      "--env <profile|url>",
      "environment profile from .qa/envs or a URL (default: environments.default)",
    )
    .option("--time-box <minutes>", "stop after this many minutes (default 10)")
    .option("--max-steps <n>", "stop after this many browser actions (default 40)")
    .action(
      (
        ticket: string,
        options: { goal: string; run?: string; env?: string; timeBox?: string; maxSteps?: string },
      ) => withPorts((ports) => runExplore(ticket, options, commandIO, ports))(),
    );
  explore
    .command("promote")
    .description("Turn an observation into a draft case in a new plan version (runs only after approval)")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .requiredOption("--session <id>", "exploratory session, e.g. S01")
    .requiredOption("--observation <id>", "observation, e.g. O1")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .action((ticket: string, options: { session: string; observation: string; run?: string }) =>
      withPorts((ports) => runExplorePromote(ticket, options, commandIO, ports))(),
    );

  const env = program.command("env").description("Check, render or start the environment");
  env
    .command("check")
    .description("List every missing or invalid variable of the environment and --build configuration")
    .option("--env <profile>", "environment profile (default: build.profile or environments.default)")
    .action((options: { env?: string }) => withPorts((ports) => runEnvCheck(options, commandIO, ports))());
  env
    .command("render")
    .description("Recreate the per-service .env files of a run (0600; removed by clean)")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .action((ticket: string, options: { run?: string }) =>
      withPorts((ports) => runEnvRender(ticket, options, commandIO, ports))(),
    );

  env
    .command("up")
    .description("Start the application from a fetched run's worktree, without agents or tests")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--set <service.VAR=value>", "override an overridable service variable (repeatable)", collect, [])
    .option("--detach", "leave the containers running; remove them with qajitsu clean")
    .action((ticket: string, options: { run?: string; set: string[]; detach?: boolean }) =>
      withPorts((ports) => runEnvUp(ticket, options, commandIO, ports))(),
    );

  program
    .command("runs")
    .description("List the runs of a ticket")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--keep <id>", "mark a run keep: retention never removes it or its evidence")
    .option("--unkeep <id>", "let a run follow the retention policy again")
    .action((ticket: string, options: { keep?: string; unkeep?: string }) =>
      withPorts((ports) => runRuns(ticket, commandIO, ports, options))(),
    );

  program
    .command("status")
    .description(
      "Project readiness, default environment, knowledge base and work in progress with the next command",
    )
    .option("--all", "every project")
    .option("--rebuild", "rebuild context.json from the run folders")
    .action(async (options: { all?: boolean; rebuild?: boolean }) => {
      // --all needs no active project: it walks every registered one (REQ-PRJ-05/AC5).
      if (options.all === true && io.ports) {
        io.setExitCode(await runStatus(options, commandIO, io.ports));
        return;
      }
      await withPorts((ports) => runStatus(options, commandIO, ports))();
    });

  program
    .command("note")
    .description("Attach a note to a ticket; status shows it next to the ticket's open work")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .argument("<text>", "the note")
    .action((ticket: string, text: string) =>
      withPorts((ports) => runNote(ticket, text, commandIO, ports, io.user ?? "unknown"))(),
    );

  program
    .command("resume")
    .description(
      "Continue a run from its last checkpoint (stops at human approval and publish); without a ticket, list resumable work",
    )
    .argument("[ticket]", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--env <profile|url>", "environment for the run stage")
    .option("--build", "build the environment for the run stage")
    .action((ticket: string | undefined, options: { run?: string; env?: string; build?: boolean }) =>
      withPorts((ports) =>
        ticket === undefined
          ? runResumable(commandIO, ports)
          : runResume(ticket, options, commandIO, ports, (stage, runId) =>
              stage === "plan"
                ? runPlan(ticket, { run: runId }, commandIO, ports, review)
                : runRun(ticket, { run: runId, env: options.env, build: options.build }, commandIO, ports),
            ),
      )(),
    );

  program
    .command("clean")
    .description(
      "Remove containers, volumes, networks, worktrees and .env files of a run (artifacts stay); --project applies retention to the whole project",
    )
    .argument("[ticket]", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--all", "every run of the ticket")
    .option(
      "--project",
      "retention (cleanup.keep_last, max_age_days) for all runs and git mirrors of the project",
    )
    .option("--dry-run", "with --project: only list what would be removed")
    .action(
      (
        ticket: string | undefined,
        options: { run?: string; all?: boolean; project?: boolean; dryRun?: boolean },
      ) => withPorts((ports) => runClean(ticket, options, commandIO, ports))(),
    );

  program
    .command("work")
    .description("Manage the open work of a ticket")
    .command("reset")
    .description("Close the ticket's open work so the next fetch starts a new run; --delete removes its runs")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--delete", "also remove the ticket's runs (except runs marked keep)")
    .action((ticket: string, options: { delete?: boolean }) =>
      withPorts((ports) => runWorkReset(ticket, options, commandIO, ports))(),
    );

  program
    .command("bench")
    .description("Benchmark a model on the seeded-bug cases (real model calls; never in PR CI)")
    .requiredOption("--model <ref>", "model reference <provider>/<model>")
    .option("--role <role>", "only this role uses the model (default: every role)")
    .option("--cases <file>", "benchmark cases (default: .qa/bench.yaml)")
    .option("--out <dir>", "where the JSON report goes (default: the project's exports/bench-results)")
    .option(
      "--knowledge <mode>",
      "on (default), off, or compare: every case without and with the knowledge base",
    )
    .action((options: { model: string; role?: string; cases?: string; out?: string; knowledge?: string }) =>
      withPorts((ports) => runBench(options, commandIO, ports, review))(),
    );

  program
    .command("audit")
    .description("Audit log tools")
    .command("verify")
    .description("Check the hash chain of run journals (also archived ones)")
    .argument("[ticket]", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--all", "every run of the ticket")
    .option("--file <journal>", "verify this journal file instead")
    .action((ticket: string | undefined, options: { run?: string; all?: boolean; file?: string }) =>
      withPorts((ports) => runAuditVerify(ticket, options, commandIO, ports))(),
    );

  program
    .command("telemetry")
    .description("OpenTelemetry tools")
    .command("export")
    .description("Send journal events not exported yet as OTLP traces, logs and metrics")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .action((ticket: string, options: { run?: string }) =>
      withPorts((ports) => runTelemetryExport(ticket, options, commandIO, ports))(),
    );

  program
    .command("metrics")
    .description("Metrics over every run (Prometheus text or JSON) for dashboards and alerts")
    .option("--format <format>", "prometheus (default) or json")
    .option("--out <file>", "write to a file atomically, e.g. for the node_exporter textfile collector")
    .action((options: { format?: string; out?: string }) =>
      withPorts((ports) => runMetrics(options, commandIO, ports))(),
    );

  program
    .command("export")
    .description("Write pipeline artifacts of a run: report.html, junit.xml, matrix and the evidence zip")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option(
      "--out <dir>",
      "artifact folder, e.g. qa-artifacts (default: the project's exports/<TICKET>/<RUN>)",
    )
    .action((ticket: string, options: { run?: string; out?: string }) =>
      withPorts((ports) => runExport(ticket, options, commandIO, ports))(),
    );

  const ci = program.command("ci").description("Pipeline helpers (GitHub Actions, GitLab CI, Jenkins)");
  ci.command("detect")
    .description(
      "Work out the trigger: labelled PR/MR, /qa comment, manual run or Jira; writes $GITHUB_OUTPUT",
    )
    .option("--label <name>", "PR/MR label that starts QAJitsu", "qa-agent")
    .option("--paths <glob...>", "only when a changed file matches one of these globs")
    .option("--format <format>", "json (default) or env (shell-safe export lines)")
    .action((options: { label?: string; paths?: string[]; format?: string }) =>
      withPorts((ports) => runCiDetect(options, commandIO, ports))(),
    );
  ci.command("comment")
    .description("Post the plan or the results to the PR/MR (one updatable comment) and set the status check")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .requiredOption("--change <url>", "PR/MR URL")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .action((ticket: string, options: { run?: string; change: string }) =>
      withPorts((ports) => runCiComment(ticket, options, commandIO, ports))(),
    );
  ci.command("publish-plan")
    .description("Post the latest plan version to the Jira ticket (one updatable comment)")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .action((ticket: string, options: { run?: string }) =>
      withPorts((ports) => runCiPublishPlan(ticket, options, commandIO, ports))(),
    );

  program
    .command("map")
    .description(
      "Application map over every run: tested and never-tested screens and endpoints (map.json, map.html)",
    )
    .option("--out <dir>", "output folder (default: the project's exports/qa-map)")
    .option("--openapi <file>", "OpenAPI document of the known endpoints (default: from the newest worktree)")
    .action((options: { out?: string; openapi?: string }) =>
      withPorts((ports) => runMap(options, commandIO, ports))(),
    );

  program
    .command("gc")
    .description("Apply retention (cleanup.keep_last, cleanup.max_age_days) to every ticket")
    .option("--dry-run", "only list the runs that would be removed")
    .action((options: { dryRun?: boolean }) => withPorts((ports) => runGc(options, commandIO, ports))());

  program
    .command("publish")
    .description("Publish the results comment and attachments to the ticket after a confirmed preview")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--auto-publish", "skip the preview (CI); recorded in run.json")
    .action((ticket: string, options: { run?: string; autoPublish?: boolean }) =>
      withPorts((ports) =>
        runPublish(ticket, options, commandIO, ports, io.user ?? "unknown", io.compressVideo),
      )(),
    );

  const baseline = program.command("baseline").description("Visual regression baselines in .qa/baselines/");
  baseline
    .command("accept")
    .description(
      "Make screenshots of a run the approved baselines (screenshots without one; changed ones on request)",
    )
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--cases <ids>", "comma-separated case ids (default: every case)")
    .option(
      "--include-failed",
      "also accept screenshots that differ from their baseline (an intended change)",
    )
    .option("--yes", "do not ask for confirmation")
    .action(
      (ticket: string, options: { run?: string; cases?: string; includeFailed?: boolean; yes?: boolean }) =>
        withPorts((ports) => runBaselineAccept(ticket, options, commandIO, ports, io.user ?? "unknown"))(),
    );

  program
    .command("answer")
    .description("Answer a manual step a running 'qj run' waits for (CI or another terminal)")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .argument("<case>", "case id, e.g. TC-02")
    .argument("<step>", "step id, e.g. S3")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--passed", "the step behaved as the plan expects")
    .option("--failed", "the step did not behave as the plan expects")
    .option("--note <text>", "what you observed (codes and secrets are masked)")
    .option("--file <path>", "a screenshot or file to attach as evidence")
    .action(
      (
        ticket: string,
        caseId: string,
        stepId: string,
        options: { run?: string; passed?: boolean; failed?: boolean; note?: string; file?: string },
      ) =>
        withPorts((ports) =>
          runAnswer(ticket, caseId, stepId, options, commandIO, ports, io.user ?? "unknown"),
        )(),
    );

  program
    .command("bug")
    .description(
      "Report FAILED cases as bugs: shows similar open bugs first, creates or links after confirmation",
    )
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--cases <ids>", "comma-separated FAILED case ids (default: every FAILED case)")
    .option("--link <key>", "link the failure to this existing bug instead of creating one (one case)")
    .option("--yes", "create without asking when no similar open bug is found")
    .option("--force-new", "with --yes: create even when similar open bugs exist")
    .action((ticket: string, options: BugOptions) =>
      withPorts((ports) => runBug(ticket, options, commandIO, ports, io.user ?? "unknown"))(),
    );

  program
    .command("promote")
    .description("Propose the run's PASSED cases as a pull/merge request to the project's tests repository")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--cases <ids>", "comma-separated case ids, e.g. TC-01,TC-03 (default: every PASSED case)")
    .option("--repo <alias>", "the tests repository when the project has several")
    .option("--dry-run", "write the pack to the project's exports; push nothing")
    .option("--yes", "push and open the pull request without asking")
    .action((ticket: string, options: PromoteOptions) =>
      withPorts((ports) => runPromote(ticket, options, commandIO, ports, io.user ?? "unknown"))(),
    );

  program
    .command("evidence")
    .description("Show statuses, failed assertions, evidence files and cURL commands of a run")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--failed", "only cases that did not pass")
    .option("--case <id>", "only this case")
    .option("--trace <case>", "open the Playwright trace of a case")
    .option("--no-open", "print only, do not open the report, videos or traces")
    .option("--serve", "serve the report and evidence on localhost until Ctrl+C")
    .option("--port <n>", "with --serve: port (default: a free one)")
    .action(
      (
        ticket: string,
        options: {
          run?: string;
          failed?: boolean;
          case?: string;
          trace?: string;
          open?: boolean;
          serve?: boolean;
          port?: string;
        },
      ) =>
        withPorts((ports) =>
          options.serve === true
            ? runEvidenceServe(ticket, options, commandIO, ports)
            : runEvidence(ticket, options, commandIO, ports, {
                ...(io.openFile ? { openFile: io.openFile } : {}),
                ...(io.openTrace ? { openTrace: io.openTrace } : {}),
              }),
        )(),
    );

  program
    .command("pull")
    .description("Download the evidence zip of a run (e.g. from CI) from the ticket and verify it")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .requiredOption("--run <id>", "run id")
    .action((ticket: string, options: { run: string }) =>
      withPorts((ports) => runPull(ticket, options.run, commandIO, ports))(),
    );

  program
    .command("logs")
    .description("Show the structured event log of a run")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--follow", "keep printing new events while the run is running")
    .option("--stage <stage>", "only this stage, e.g. run or plan")
    .option("--agent <role>", "only this agent, e.g. planner")
    .option("--case <id>", "only events of this case")
    .action(
      (
        ticket: string,
        options: { run?: string; follow?: boolean; stage?: string; agent?: string; case?: string },
      ) => withPorts((ports) => runLogs(ticket, options, commandIO, ports))(),
    );

  return program;
}
