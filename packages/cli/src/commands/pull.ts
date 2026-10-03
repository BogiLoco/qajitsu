import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createJiraAttachmentReader } from "@qajitsu/adapter-publish-jira";
import { ConfigError, QajitsuError, RunIdSchema, TicketKeySchema, resolveWorkspaceRoot } from "@qajitsu/core";
import { unzip } from "@qajitsu/report";
import { createMasker } from "@qajitsu/steps";
import { checkManifest } from "@qajitsu/verifier";
import { readManifest } from "@qajitsu/adapter-evidence-local";
import type { RuntimePorts } from "../adapters.js";
import { createCliSecretResolver } from "../adapters.js";
import { createCliLogger } from "../logger.js";
import { loadProject } from "../project.js";
import type { CommandIO } from "./fetch.js";

/**
 * `qajitsu pull <TICKET> --run <id>`: downloads the evidence zip a (CI) run attached to the ticket and
 * unpacks it into `<root>/<TICKET>/<RUN-ID>-pulled/`, then re-checks the manifest hashes (REQ-PUB-06/AC3).
 *
 * @returns 0 pulled and verified, 2 pulled but hashes differ, 3 errors.
 */
export async function runPull(
  rawKey: string,
  runId: string,
  io: CommandIO,
  ports: RuntimePorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const key = TicketKeySchema.parse(rawKey);
    const id = RunIdSchema.parse(runId);
    const project = await loadProject(io.cwd);
    const jira = project.config.jira;
    if (jira.type === "file")
      throw new ConfigError("PULL_NEEDS_JIRA", "qj pull reads Jira attachments; jira.type is 'file'.", {});
    const root = resolveWorkspaceRoot({
      configured: project.config.workspace.root,
      home: ports.home,
      cwd: project.qaDir,
    });
    const target = join(root, key, `${id}-pulled`);
    await mkdir(target, { recursive: true });
    const reader = createJiraAttachmentReader(
      {
        flavor: jira.type,
        baseUrl: jira.base_url ?? "",
        email: jira.email,
        token: jira.token ?? "",
        mediaHosts: project.config.publish.media_hosts,
      },
      {
        fetch: ports.fetch,
        logger: createCliLogger({ file: join(target, "pull.log"), mask: (v) => masker.maskJson(v) }),
        now: ports.now,
        resolveSecret: createCliSecretResolver(project, ports, masker),
        registerSecret: (v) => {
          masker.register(v);
        },
      },
    );
    const name = `${key}_${id}_evidence.zip`;
    const attachment = (await reader.list(key)).find((a) => a.filename === name);
    if (!attachment) throw new ConfigError("PULL_NOT_FOUND", `${key} has no attachment ${name}.`, { name });
    const archive = await reader.download(attachment);
    const entries = unzip(archive);
    for (const entry of entries) {
      const file = join(target, entry.name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, entry.data);
    }
    // Traces are never published, so they are not expected in the archive.
    const manifest = (await readManifest(join(target, "evidence"))).filter((m) => m.kind !== "trace");
    const check = await checkManifest(join(target, "evidence"), manifest);
    io.write(`Pulled ${String(entries.length)} file(s) into ${target}\n`);
    io.write(
      `Archive sha256 ${createHash("sha256").update(archive).digest("hex")}: compare it with the hash in the Jira comment.\n`,
    );
    if (check.problems.length > 0) {
      io.writeError(
        `Evidence does not match its manifest:\n${check.problems.map((p) => `  - ${p}`).join("\n")}\n`,
      );
      return 2;
    }
    // The manifest comes from the same archive: this proves consistency, not origin.
    io.write(
      `Archive is consistent with its own manifest. Only open ${join(target, "report", "report.html")} if the hash matches the comment.\n`,
    );
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
