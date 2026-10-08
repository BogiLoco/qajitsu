import { readFile, readdir, stat } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import { readDeployedSha } from "@qajitsu/adapter-env-remote";
import {
  RunRecordSchema,
  listTickets,
  readRunIndex,
  resolveEnvironment,
  resolveWorkspaceRoot,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { buildAdapters, createCliSecretResolver, type RuntimePorts } from "./adapters.js";
import { createCliLogger } from "./logger.js";
import { resolveConfigPath, type LoadedProject } from "./project.js";

/** One line about the application under test (REQ-GEN-03/AC5). */
export interface AppVersionLine {
  readonly name: string;
  readonly detail: string;
  /** False only for a real problem (an unreadable mirror); unknown and not yet fetched are information. */
  readonly ok: boolean;
}

const short = (sha: string | undefined): string => (sha ? sha.slice(0, 12) : "–");

/** The newest run of the project that recorded a commit for each repository alias. */
async function latestRunCommits(
  root: string,
): Promise<Map<string, { sha: string; ticket: string; run: string; at: string }>> {
  const out = new Map<string, { sha: string; ticket: string; run: string; at: string }>();
  for (const ticket of await listTickets(root)) {
    for (const entry of (await readRunIndex(root, ticket)).runs) {
      const record = RunRecordSchema.safeParse(
        JSON.parse(
          await readFile(join(root, ticket, entry.runId, "run.json"), "utf8").catch(() => "null"),
        ) as unknown,
      );
      if (!record.success) continue;
      for (const [alias, repo] of Object.entries(record.data.repos)) {
        const known = out.get(alias);
        if (!known || record.data.createdAt > known.at)
          out.set(alias, { sha: repo.sha, ticket, run: entry.runId, at: record.data.createdAt });
      }
    }
  }
  return out;
}

/**
 * The versions of the application under test the project knows (REQ-GEN-03/AC5): per repository its git mirror
 * (exists, last updated, commit of the default branch) and the commit of the latest run; with `online` the commit on
 * the remote and, for each environment profile with a version path, the deployed version compared with the latest
 * run; and where the mobile app binary comes from. Nothing here downloads code.
 */
export async function appVersions(
  project: LoadedProject,
  ports: RuntimePorts,
  options: { readonly online: boolean },
): Promise<AppVersionLine[]> {
  const { config } = project;
  const lines: AppVersionLine[] = [];
  const masker = createMasker();
  const resolveSecret = createCliSecretResolver(project, ports, masker);
  const cache = resolveConfigPath(config.workspace.git_cache ?? "~/.qa-cache/git", project.qaDir, ports.home);
  const root = resolveWorkspaceRoot({
    configured: config.workspace.root,
    home: ports.home,
    cwd: project.qaDir,
  });
  const runs = await latestRunCommits(root);
  const hosts = options.online
    ? buildAdapters(
        project,
        {
          fetch: ports.fetch,
          logger: createCliLogger({ file: devNull, mask: (v) => masker.maskJson(v) }),
          now: ports.now,
          resolveSecret,
          registerSecret: (v) => {
            masker.register(v);
          },
        },
        ports,
      ).codeHosts
    : {};
  for (const [alias, repo] of Object.entries(config.repos)) {
    const mirror = join(cache, repo.host, `${repo.path}.git`);
    const last = runs.get(alias);
    const lastText = last ? `last run ${short(last.sha)} (${last.ticket} ${last.run})` : "no run yet";
    const info = await stat(join(mirror, "HEAD")).catch(() => undefined);
    if (!info) {
      lines.push({ name: alias, ok: true, detail: `no mirror yet (qj fetch downloads it) · ${lastText}` });
    } else {
      const updated = (await stat(join(mirror, "FETCH_HEAD")).catch(() => info)).mtime;
      const head = await ports
        .gitExec(["-C", mirror, "rev-parse", "--verify", `refs/heads/${repo.default_ref}^{commit}`])
        .then((r) => r.stdout.trim())
        .catch(() => undefined);
      if (head === undefined)
        lines.push({
          name: alias,
          ok: false,
          detail: `the mirror ${mirror} cannot be read; fix: qj clean --project, then qj fetch downloads it again`,
        });
      else
        lines.push({
          name: alias,
          ok: true,
          detail: `mirror updated ${updated.toISOString().slice(0, 16).replace("T", " ")} · ${repo.default_ref} ${short(head)} · ${lastText}`,
        });
      const host = hosts[repo.host];
      if (head !== undefined && host) {
        const remote = await host
          .resolveChange({ repo: repo.path, kind: "branch", id: repo.default_ref })
          .then((c) => c.headSha)
          .catch(() => undefined);
        lines.push({
          name: `${alias} remote`,
          ok: true,
          detail:
            remote === undefined
              ? `${repo.default_ref} unknown (the code host did not answer)`
              : remote === head
                ? `${repo.default_ref} ${short(remote)}, the mirror is up to date`
                : `${repo.default_ref} ${short(remote)}: newer than the mirror (${short(head)}); the next qj fetch updates it`,
        });
      }
    }
  }
  if (options.online) {
    const runShas = [...runs.values()].map((r) => r.sha);
    for (const name of (await readdir(join(project.qaDir, "envs")).catch(() => [] as string[]))
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => f.replace(/\.ya?ml$/, ""))
      .sort()) {
      const env = await resolveEnvironment({ config, qaDir: project.qaDir, env: name }).catch(
        () => undefined,
      );
      if (!env?.versionPath) continue;
      const deployed = await readDeployedSha(env, ports.fetch);
      const matching =
        deployed === undefined
          ? undefined
          : [...runs.entries()].find(([, r]) => r.sha.startsWith(deployed) || deployed.startsWith(r.sha));
      lines.push({
        name: `env ${name}`,
        ok: true,
        detail:
          deployed === undefined
            ? `deployed version unknown (${env.baseUrl}${env.versionPath} did not answer with a commit)`
            : matching
              ? `deployed ${short(deployed)} = the latest run of ${matching[0]}`
              : `deployed ${short(deployed)}${runShas.length > 0 ? ", not the commit of any latest run" : ""}`,
      });
    }
  }
  const apps = [["android app", config.mobile?.android?.app] as const];
  for (const [name, app] of apps) {
    if (!app) continue;
    lines.push({
      name,
      ok: true,
      detail:
        app.source === "ci"
          ? `CI artifact '${app.artifact}' (${app.file}) of ${app.repo}, for the commit of each run`
          : app.source === "build"
            ? `built in the ${app.repo} worktree of each run: ${app.command.join(" ")} → ${app.output}`
            : `${app.path} in the ${app.repo} worktree of each run`,
    });
  }
  if (config.mobile?.ios?.farm)
    lines.push({
      name: "ios app",
      ok: true,
      detail: `uploaded to ${config.mobile.ios.farm.provider}: ${config.mobile.ios.farm.app}`,
    });
  return lines.map((l) => ({ ...l, detail: masker.maskText(l.detail) }));
}

/** The "Application under test" section of `qj doctor` (REQ-GEN-03/AC5). */
export function formatAppVersions(lines: readonly AppVersionLine[]): string {
  if (lines.length === 0) return "Application under test: no repositories configured.";
  const width = Math.max(...lines.map((l) => l.name.length));
  return [
    "Application under test:",
    ...lines.map((l) => `  ${l.ok ? "✔" : "✘"} ${l.name.padEnd(width)}  ${l.detail}`),
  ].join("\n");
}
