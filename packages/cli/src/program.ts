import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import type { RuntimePorts } from "./adapters.js";
import { formatProbes, probeModels } from "@qajitsu/agents";
import { runFetch } from "./commands/fetch.js";
import { runApprove, runPlan } from "./commands/plan.js";
import { runEvidence } from "./commands/evidence.js";
import { runLogs } from "./commands/logs.js";
import { runPublish } from "./commands/publish.js";
import { runPull } from "./commands/pull.js";
import { runRun, type RunPorts } from "./commands/run.js";
import { runClean, runGc, runResume, runRuns } from "./commands/runs.js";
import { runEnvCheck, runEnvRender } from "./commands/env.js";
import { runBench } from "./commands/bench.js";
import { runAuditVerify } from "./commands/audit.js";
import { runTelemetryExport } from "./commands/telemetry.js";
import { runMetrics } from "./commands/metrics.js";
import { runInit } from "./commands/init.js";
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
    .configureOutput({ writeOut: io.write, writeErr: io.writeError })
    .showHelpAfterError();

  const withPorts =
    (run: (ports: RuntimePorts & ModelPorts) => Promise<number>) => async (): Promise<void> => {
      if (!io.ports) {
        io.writeError("Runtime ports are not configured.\n");
        io.setExitCode(3);
        return;
      }
      io.setExitCode(await run(io.ports));
    };
  const commandIO = { write: io.write, writeError: io.writeError, cwd: io.cwd, ask: io.ask };
  const review = { user: io.user ?? "unknown", openEditor: io.openEditor };

  program
    .command("init")
    .description("Create .qa/ for this repository (detects git host, compose services, OpenAPI, test types)")
    .option("--yes", "do not ask; use detected values and flags")
    .option("--force", "replace an existing .qa/qa.project.yaml")
    .option("--jira-url <url>", "Jira base URL (empty: tickets from files)")
    .option("--project-key <key>", "Jira project key")
    .option("--env-url <url>", "URL of the test environment")
    .action(
      async (options: {
        yes?: boolean;
        force?: boolean;
        jiraUrl?: string;
        projectKey?: string;
        envUrl?: string;
      }) => {
        io.setExitCode(await runInit(options, commandIO));
      },
    );

  program
    .command("doctor")
    .description("Check that this machine and project are ready for QAJitsu")
    .option("--models", "probe the configured model of every role (makes real model calls)")
    .option("--online", "check access to Jira and every code host (makes real requests)")
    .action(async (options: { models?: boolean; online?: boolean }) => {
      const checks = runDoctor({
        nodeVersion: io.nodeVersion,
        hasProjectConfig: existsSync(join(io.cwd, ".qa", "qa.project.yaml")),
      });
      if (checks.every((c) => c.ok) && io.ports) {
        // REQ-GEN-03/AC2: secrets, Docker, Android/Appium and, with --online, Jira and code hosts.
        try {
          checks.push(
            ...(await projectChecks(await loadProject(io.cwd), io.ports, {
              online: options.online === true,
            })),
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
          const project = await loadProject(io.cwd);
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
    .action((ticket: string, options: { run?: string; revise?: string }) =>
      withPorts((ports) => runPlan(ticket, options, commandIO, ports, review))(),
    );

  program
    .command("approve")
    .description("Approve and freeze a plan version (SHA-256 recorded in run.json)")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--version <n>", "plan version (default: latest)")
    .option("--confirm-open-questions", "approve although the plan has open questions")
    .action((ticket: string, options: { run?: string; version?: string; confirmOpenQuestions?: boolean }) =>
      withPorts((ports) => runApprove(ticket, options, commandIO, ports, review))(),
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
    .action(async (ticket: string, options: { pr: string[]; mr: string[]; ref: string[] }) => {
      if (!io.ports) {
        io.writeError("Runtime ports are not configured.\n");
        io.setExitCode(3);
        return;
      }
      io.setExitCode(
        await runFetch(
          ticket,
          options,
          { write: io.write, writeError: io.writeError, cwd: io.cwd, ask: io.ask },
          io.ports,
        ),
      );
    });

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
    .action(
      (
        ticket: string,
        options: { run?: string; env?: string; build?: boolean; keep?: boolean; set: string[] },
      ) => withPorts((ports) => runRun(ticket, options, commandIO, ports))(),
    );

  const env = program.command("env").description("Check or render the environment configuration");
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

  program
    .command("runs")
    .description("List the runs of a ticket")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .action((ticket: string) => withPorts((ports) => runRuns(ticket, commandIO, ports))());

  program
    .command("resume")
    .description("Continue a run from its last checkpoint (stops at human approval and publish)")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--env <profile|url>", "environment for the run stage")
    .option("--build", "build the environment for the run stage")
    .action((ticket: string, options: { run?: string; env?: string; build?: boolean }) =>
      withPorts((ports) =>
        runResume(ticket, options, commandIO, ports, (stage, runId) =>
          stage === "plan"
            ? runPlan(ticket, { run: runId }, commandIO, ports, review)
            : runRun(ticket, { run: runId, env: options.env, build: options.build }, commandIO, ports),
        ),
      )(),
    );

  program
    .command("clean")
    .description("Remove containers, volumes, networks, worktrees and .env files of a run; artifacts stay")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--all", "every run of the ticket")
    .action((ticket: string, options: { run?: string; all?: boolean }) =>
      withPorts((ports) => runClean(ticket, options, commandIO, ports))(),
    );

  program
    .command("bench")
    .description("Benchmark a model on the seeded-bug cases (real model calls; never in PR CI)")
    .requiredOption("--model <ref>", "model reference <provider>/<model>")
    .option("--role <role>", "only this role uses the model (default: every role)")
    .option("--cases <file>", "benchmark cases (default: .qa/bench.yaml)")
    .option("--out <dir>", "where the JSON report goes (default: <project>/bench-results)")
    .action((options: { model: string; role?: string; cases?: string; out?: string }) =>
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

  program
    .command("evidence")
    .description("Show statuses, failed assertions, evidence files and cURL commands of a run")
    .argument("<ticket>", "Jira key, e.g. SHOP-482")
    .option("--run <id>", "run id (default: latest run of the ticket)")
    .option("--failed", "only cases that did not pass")
    .option("--case <id>", "only this case")
    .option("--trace <case>", "open the Playwright trace of a case")
    .option("--no-open", "print only, do not open the report, videos or traces")
    .action(
      (
        ticket: string,
        options: { run?: string; failed?: boolean; case?: string; trace?: string; open?: boolean },
      ) =>
        withPorts((ports) =>
          runEvidence(ticket, options, commandIO, ports, {
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
