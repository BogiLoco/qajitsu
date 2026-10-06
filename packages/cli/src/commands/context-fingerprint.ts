import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunSession } from "../session.js";

/** What a run's approval depends on besides the plan: environments and secrets (REQ-PRJ-06/AC3). */
export interface ApprovalContext {
  readonly environment: string;
  readonly secrets: string;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The project's fingerprint key: random, 0600, never in run folders, so stored fingerprints reveal nothing. */
async function fingerprintKey(session: RunSession): Promise<Buffer> {
  const home = session.project.project?.paths.cache;
  const file = home ? join(home, "context.key") : undefined;
  if (file === undefined) return Buffer.alloc(32);
  const existing = await readFile(file).catch(() => undefined);
  if (existing?.length === 32) return existing;
  const key = randomBytes(32);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, key, { mode: 0o600, flag: "w" });
  return key;
}

const collectRefs = (value: unknown, out: Set<string>): void => {
  if (typeof value === "string") {
    if (value.startsWith("secret://")) out.add(value);
  } else if (Array.isArray(value))
    value.forEach((v) => {
      collectRefs(v, out);
    });
  else if (value !== null && typeof value === "object")
    Object.values(value).forEach((v) => {
      collectRefs(v, out);
    });
};

/**
 * Fingerprints what an approved run will use besides its frozen plan (REQ-PRJ-06/AC3): the `environments` section
 * and every environment profile in `.qa/envs/`, and the value of every `secret://` reference in them and in the
 * project config. Secret values enter only as an HMAC with the project's key; nothing secret is stored.
 *
 * @param session - The run.
 */
export async function approvalContext(session: RunSession): Promise<ApprovalContext> {
  const { project } = session;
  const envDir = join(project.qaDir, "envs");
  const profiles: Record<string, string> = {};
  const refs = new Set<string>();
  collectRefs(project.config, refs);
  for (const name of (await readdir(envDir).catch(() => [] as string[])).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = await readFile(join(envDir, name), "utf8");
    profiles[name] = sha(text);
    for (const m of text.matchAll(/secret:\/\/[a-z0-9-]+\/[^\s"',}\]]+/g)) refs.add(m[0]);
  }
  const key = await fingerprintKey(session);
  const secrets: Record<string, string> = {};
  for (const ref of [...refs].sort()) {
    const value = await session.resolveSecret(ref).catch(() => undefined);
    secrets[ref] = value === undefined ? "missing" : createHmac("sha256", key).update(value).digest("hex");
  }
  return {
    environment: sha(JSON.stringify({ environments: project.config.environments, profiles })),
    secrets: sha(JSON.stringify(secrets)),
  };
}

/** Names what changed between two approval contexts. */
export function changedParts(before: ApprovalContext, now: ApprovalContext): string[] {
  return [
    ...(before.environment !== now.environment ? ["environment"] : []),
    ...(before.secrets !== now.secrets ? ["secrets"] : []),
  ];
}
