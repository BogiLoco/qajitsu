#!/usr/bin/env node
// REQ-GEN-15/AC2 + REQ-GEN-09: after publishing, every package of the release must be in the registry with npm
// provenance from this repository's Release workflow on main, from this very run, for the tarball the registry
// serves. `pnpm -r publish` skips a version that is already there; one that someone published with a leaked token in
// the minutes between scripts/unpublished-check.mjs and the publish would otherwise be tagged and baked into the image.
// A published version is immutable, so what this checks is what `npm pack name@version` gets later.
//
//   node scripts/provenance-check.mjs <run id>    fails unless every package has this run's provenance

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishablePackages } from "./release-check.mjs";

const SLSA = "https://slsa.dev/provenance/v1";
/** Where the packages must have been built. */
export const EXPECTED = {
  repository: "https://github.com/BogiLoco/qajitsu",
  path: ".github/workflows/release.yml",
  ref: "refs/heads/main",
  event: "push",
};

/** The purl npm puts in a provenance subject: the scope's `@` is percent-encoded. */
export const purl = (name, version) => `pkg:npm/${name.replace(/^@/, "%40")}@${version}`;

/** The hex SHA-512 of an npm `sha512-<base64>` integrity, or undefined. */
export function integrityHex(integrity) {
  const m = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(String(integrity ?? ""));
  if (!m) return undefined;
  const hex = Buffer.from(m[1] ?? "", "base64").toString("hex");
  return hex.length === 128 ? hex : undefined;
}

/**
 * What is wrong with a package's provenance, judged from the registry's attestations and the tarball's integrity.
 *
 * @param {{ name: string, version: string }} pkg
 * @param {{ attestations?: { predicateType?: string, bundle?: { dsseEnvelope?: { payload?: string } } }[] } | undefined} attestations
 *   - The registry's answer for the version's attestations.
 * @param {string | undefined} integrity - `dist.integrity` of the version.
 * @param {string} runId - The run that must have published it.
 * @returns {string[]}
 */
export function provenanceProblems(pkg, attestations, integrity, runId) {
  const spec = `${pkg.name}@${pkg.version}`;
  const slsa = (attestations?.attestations ?? []).filter((a) => a.predicateType === SLSA);
  if (slsa.length !== 1) return [`${spec} has ${String(slsa.length)} SLSA provenance attestations, not one`];
  let statement;
  try {
    statement = JSON.parse(
      Buffer.from(slsa[0]?.bundle?.dsseEnvelope?.payload ?? "", "base64").toString("utf8"),
    );
  } catch {
    return [`${spec} has a provenance that cannot be read`];
  }
  const out = [];
  const subjects = statement?.subject ?? [];
  const tarball = integrityHex(integrity);
  if (tarball === undefined) out.push(`${spec} has no SHA-512 integrity in the registry`);
  if (
    !Array.isArray(subjects) ||
    subjects.length !== 1 ||
    subjects[0]?.name !== purl(pkg.name, pkg.version) ||
    (tarball !== undefined && subjects[0]?.digest?.sha512 !== tarball)
  )
    out.push(`${spec}: the provenance is not about the tarball the registry serves`);
  const workflow = statement?.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
  for (const key of ["repository", "path", "ref"])
    if (workflow[key] !== EXPECTED[key])
      out.push(`${spec} was built by ${key} ${String(workflow[key])}, not ${EXPECTED[key]}`);
  const event = statement?.predicate?.buildDefinition?.internalParameters?.github?.event_name;
  if (event !== EXPECTED.event)
    out.push(`${spec} was built for a ${String(event)} event, not ${EXPECTED.event}`);
  const invocation = String(statement?.predicate?.runDetails?.metadata?.invocationId ?? "");
  if (!invocation.startsWith(`${EXPECTED.repository}/actions/runs/${runId}/attempts/`))
    out.push(`${spec} was published by ${invocation || "an unknown run"}, not by run ${runId}`);
  return out;
}

/** Fetches JSON from the registry; undefined on 404, throws on any other failure. */
async function registry(path) {
  const res = await fetch(`https://registry.npmjs.org/${path}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`the registry answered ${String(res.status)} for ${path}`);
  return res.json();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runId = process.argv[2] ?? "";
  if (!/^\d+$/.test(runId)) {
    process.stderr.write("usage: node scripts/provenance-check.mjs <run id>\n");
    process.exitCode = 1;
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const packages = publishablePackages(root).map((p) => ({
      name: p.manifest.name,
      version: p.manifest.version,
    }));
    const problems = [];
    try {
      for (const p of packages) {
        const spec = `${p.name.replace("/", "%2f")}@${p.version}`;
        const meta = await registry(`${p.name.replace("/", "%2f")}/${p.version}`);
        if (meta === undefined) {
          problems.push(`${p.name}@${p.version} is not in the registry`);
          continue;
        }
        problems.push(
          ...provenanceProblems(
            p,
            await registry(`-/npm/v1/attestations/${spec}`),
            meta.dist?.integrity,
            runId,
          ),
        );
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    if (problems.length > 0) {
      process.stderr.write(`Provenance refused:\n${problems.map((p) => `- ${p}`).join("\n")}\n`);
      process.exitCode = 1;
    } else
      process.stdout.write(
        `${String(packages.length)} packages published by run ${runId} of ${EXPECTED.path} on ${EXPECTED.ref}.\n`,
      );
  }
}
