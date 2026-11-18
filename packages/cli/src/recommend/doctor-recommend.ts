import { recommendTools } from "@qajitsu/agents";
import type { ModelRegistry } from "@qajitsu/models";
import { TOOL_IDS, type ToolId } from "@qajitsu/toolchain";
import type { CommandIO } from "../commands/fetch.js";
import { scanRepository } from "./detect.js";
import {
  checkRecommendation,
  codeRecommendation,
  formatRecommendation,
  shown,
  type Recommendation,
} from "./rules.js";

/** Options of `qj doctor --recommend`. */
export interface RecommendOptions {
  /** Install the recommended set without asking (CI, REQ-GEN-13/AC4). */
  readonly yes?: boolean | undefined;
  /** Do not ask a model: the code's findings alone (REQ-GEN-13/AC5). */
  readonly offline?: boolean | undefined;
}

/** What the command needs: the repository, the models (none outside a project), the machine and the installer. */
export interface RecommendDeps {
  readonly root: string;
  readonly models?: ModelRegistry | undefined;
  readonly host: { readonly os: string };
  /** Installs exactly these tools (`qj setup --only`); `yes` accepts licences on the user's behalf. */
  readonly setup: (tools: readonly ToolId[], yes: boolean) => Promise<number>;
  /** Masks a message before it is shown (a model error can quote a key). */
  readonly mask: (text: string) => string;
  /** The repository's own files (`git ls-files`); undefined outside git, then the folders are walked. */
  readonly tracked?: () => Promise<readonly string[] | undefined>;
}

/**
 * `qj doctor --recommend` (REQ-GEN-13): finds by code what the application in the repository is and how it can be
 * tested, lets a model turn that into a recommendation checked by code (or, offline, recommends from the findings
 * alone), shows what to install with sizes and what not and why, and installs only after a yes (or `--yes`).
 *
 * @returns 0 shown (and installed when confirmed), the setup's exit code when it failed, 3 errors.
 */
export async function runDoctorRecommend(
  options: RecommendOptions,
  io: CommandIO,
  deps: RecommendDeps,
): Promise<number> {
  const scan = await scanRepository(deps.root, { tracked: await deps.tracked?.() });
  const baseline = codeRecommendation(scan.findings, deps.host);
  io.write(
    `Looked at ${String(scan.files)} file(s) in ${deps.root}${scan.truncated ? " (stopped at the limit: the findings are what it saw)" : ""}.\n`,
  );
  for (const f of scan.findings) io.write(`  ${f.id} ${f.kind}: ${shown(f.detail)}\n`);
  let recommendation: Recommendation = baseline;
  const model =
    options.offline === true || deps.models === undefined
      ? undefined
      : await deps.models.forRole("analyst").catch(() => undefined);
  if (model !== undefined && scan.findings.length > 0) {
    try {
      const proposed = await recommendTools({
        model,
        findings: scan.findings,
        // L1: the code's recommendation goes without file paths (they are repository data, in the findings).
        baseline: {
          install: baseline.install.map((a) => ({ tool: a.tool, basis: a.basis })),
          skip: baseline.skip,
          settings: baseline.settings.map((x) => ({ key: x.key, basis: x.basis })),
        },
        tools: TOOL_IDS,
      });
      const checked = checkRecommendation(proposed, scan.findings, baseline);
      recommendation = checked.recommendation;
      for (const d of checked.dropped) io.write(`  dropped from the model's proposal: ${shown(d)}\n`);
    } catch (error) {
      io.writeError(
        `Warning: ${model.id} gave no usable recommendation (${shown(deps.mask(error instanceof Error ? error.message : String(error))).slice(0, 200)}); the findings alone decide.\n`,
      );
    }
  }
  io.write(formatRecommendation(recommendation, scan.findings));
  const tools = recommendation.install.map((a) => a.tool);
  if (tools.length === 0) return 0;
  // REQ-GEN-13/AC4: nothing is installed without a yes; --yes installs exactly the recommended set.
  if (options.yes === true) return deps.setup(tools, true);
  if (!io.ask) {
    io.write("Nothing installed. Run the command above, or qj doctor --recommend --yes in CI.\n");
    return 0;
  }
  const answer = (await io.ask(`Install ${tools.join(", ")} now? [y/N] `)).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    io.write("Nothing installed.\n");
    return 0;
  }
  return deps.setup(tools, false);
}
