#!/usr/bin/env node
// REQ-GEN-15/AC2: pushes the tags `scripts/release-tags.mjs` created and makes one GitHub release for the version:
// the CLI's changelog for it and every package published with it. Runs in the Release workflow after publishing.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TAGS_FILE } from "./release-tags.mjs";

/**
 * The section of a changesets CHANGELOG.md for one version, without its heading; empty when there is none.
 *
 * @param {string} changelog
 * @param {string} version
 */
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

/** The release tags the image notes may edit: the CLI's, for a release version. */
const RELEASE_TAG = /^@qajitsu\/cli@\d+\.\d+\.\d+(-[\w.]+)?$/;
/** The only image the notes may name. */
export const RELEASE_IMAGE = "ghcr.io/bogiloco/qajitsu";
/** The one identity that signs release images: the reusable Image publish workflow, called from main. */
export const SIGNER =
  "https://github.com/BogiLoco/qajitsu/.github/workflows/image-publish.yml@refs/heads/main";

/**
 * The release notes with the image section set (REQ-GEN-09): added once, replaced when the image job runs again.
 *
 * @param {string} current - The notes as they are.
 * @param {string} section - The section from {@link imageNotes}, starting with a blank line and `### Image`.
 */
export function withImageNotes(current, section) {
  const at = current.indexOf("\n### Image\n");
  const before = (at < 0 ? current : current.slice(0, at)).trimEnd();
  return `${before}\n${section}`;
}

/**
 * Why the image notes may not be written for these arguments, or undefined (L1: no value reaches `gh` unchecked).
 *
 * @param {string} tag
 * @param {string} image
 */
export function imageNotesRefusal(tag, image) {
  if (!RELEASE_TAG.test(tag)) return `${tag} is not a release tag of the CLI`;
  if (image !== RELEASE_IMAGE) return `${image} is not ${RELEASE_IMAGE}`;
  return undefined;
}

/**
 * The section the image job adds to the release notes (REQ-GEN-09/AC3+AC4): the image by digest and how to check it.
 *
 * @param {string} image - e.g. `ghcr.io/bogiloco/qajitsu`.
 * @param {string} digest - `sha256:...`.
 * @param {string[]} tags - The tags it was pushed with.
 */
export function imageNotes(image, digest, tags) {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`${digest} is not an image digest`);
  const ref = `${image}@${digest}`;
  return [
    "",
    "### Image",
    "",
    `\`${ref}\` (tags ${tags.map((t) => `\`${t}\``).join(", ")}; amd64 and arm64)`,
    "",
    "```sh",
    `docker run --rm ${ref} demo`,
    `cosign verify ${ref} \\`,
    `  --certificate-identity ${SIGNER} \\`,
    "  --certificate-oidc-issuer https://token.actions.githubusercontent.com \\",
    "  --certificate-github-workflow-repository BogiLoco/qajitsu --certificate-github-workflow-ref refs/heads/main \\",
    "  --certificate-github-workflow-trigger push",
    `gh attestation verify oci://${ref} --repo BogiLoco/qajitsu \\`,
    "  --signer-workflow BogiLoco/qajitsu/.github/workflows/image-publish.yml --source-ref refs/heads/main --deny-self-hosted-runners",
    "```",
    "",
    "Run it by digest and pass the digest in, so the run records the image it ran in:",
    `\`docker run --rm -v "$PWD:/work" -e QAJITSU_IMAGE_DIGEST=${digest} ${ref} run <TICKET>\``,
    "",
  ].join("\n");
}

/**
 * The GitHub release for the new tags: one per version, named after the CLI, or undefined when the CLI was not
 * published in this run.
 *
 * @param {{ tag: string, packageName: string }[]} tags
 * @param {(version: string) => string} cliChangelog - The CLI's changelog section for a version.
 */
export function releaseFor(tags, cliChangelog) {
  const cli = tags.find((t) => t.packageName === "@qajitsu/cli");
  if (!cli) return undefined;
  const version = cli.tag.slice(cli.tag.lastIndexOf("@") + 1);
  const notes = [
    cliChangelog(version) || "See the changelogs of the packages.",
    "",
    "### Packages",
    "",
    ...tags.map((t) => `- \`${t.tag}\``).sort(),
    "",
    "Install: `npm install -g @qajitsu/cli`. Every package is published from CI with npm provenance.",
    "",
  ].join("\n");
  return { tag: cli.tag, title: `QAJitsu ${version}`, notes };
}

/**
 * The git configuration that lets `git push` authenticate with the workflow's token, passed through the environment
 * so the token is neither in the command line nor in `.git/config` (the checkout keeps no credentials).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function pushAuth(env) {
  const token = env.GH_TOKEN;
  if (!token || env.GITHUB_ACTIONS !== "true") return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${String(r.status)})`);
};

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain && process.argv[2] === "--image-notes") {
  // node scripts/github-release.mjs --image-notes <release tag> <image> <digest> <tag,tag,...>
  const [tag, image, digest, tags] = process.argv.slice(3).map(String);
  const refusal = imageNotesRefusal(tag, image);
  if (refusal) throw new Error(refusal);
  const current = spawnSync("gh", ["release", "view", tag, "--json", "body", "--jq", ".body"], {
    encoding: "utf8",
  });
  if (current.status !== 0) throw new Error(`gh release view ${tag} failed`);
  const notes = join(mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "qajitsu-notes-")), "notes.md");
  writeFileSync(notes, withImageNotes(current.stdout, imageNotes(image, digest, tags.split(","))));
  run("gh", ["release", "edit", tag, "--notes-file", notes]);
} else if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const readTags = () => {
    try {
      return JSON.parse(readFileSync(TAGS_FILE, "utf8"));
    } catch {
      return [];
    }
  };
  const tags = readTags();
  if (tags.length === 0) {
    process.stdout.write("No new tags: nothing was published in this run.\n");
  } else {
    run("git", ["push", "origin", ...tags.map((t) => `refs/tags/${t.tag}`)], pushAuth(process.env));
    const release = releaseFor(tags, (version) =>
      changelogSection(readFileSync(join(root, "packages", "cli", "CHANGELOG.md"), "utf8"), version),
    );
    if (release) {
      const notes = join(
        mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "qajitsu-notes-")),
        "notes.md",
      );
      writeFileSync(notes, release.notes);
      run("gh", [
        "release",
        "create",
        release.tag,
        "--verify-tag",
        "--title",
        release.title,
        "--notes-file",
        notes,
      ]);
      // The image job builds this version and adds its digest to these notes (REQ-GEN-09).
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(
          process.env.GITHUB_OUTPUT,
          `version=${release.tag.slice(release.tag.lastIndexOf("@") + 1)}\ntag=${release.tag}\n`,
        );
    }
  }
}
