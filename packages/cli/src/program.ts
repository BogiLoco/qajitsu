import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import type { RuntimePorts } from "./adapters.js";
import { formatProbes, probeModels } from "@qajitsu/agents";
import { runFetch } from "./commands/fetch.js";
import { runApprove, runPlan } from "./commands/plan.js";
import { runRun, type RunPorts } from "./commands/run.js";
import { loadProject } from "./project.js";
import type { ModelPorts } from "./session.js";
import { formatDoctor, runDoctor } from "./doctor.js";

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
    .command("doctor")
    .description("Check that this machine and project are ready for QAJitsu")
    .option("--models", "probe the configured model of every role (makes real model calls)")
    .action(async (options: { models?: boolean }) => {
      const checks = runDoctor({
        nodeVersion: io.nodeVersion,
        hasProjectConfig: existsSync(join(io.cwd, ".qa", "qa.project.yaml")),
      });
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
    .action((ticket: string, options: { run?: string; env?: string }) =>
      withPorts((ports) => runRun(ticket, options, commandIO, ports))(),
    );

  return program;
}
