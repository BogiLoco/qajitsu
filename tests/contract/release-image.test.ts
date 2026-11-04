// The release image's Dockerfile (REQ-GEN-09/AC5+AC6): what it is built from, which user it runs as, what it runs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(new URL("../../ci/docker/Dockerfile.release", import.meta.url), "utf8");
const entrypoint = readFileSync(new URL("../../ci/docker/entrypoint.sh", import.meta.url), "utf8");
/** The instructions, with continued lines joined and comments left out. */
const instructions = dockerfile
  .replace(/\\\n/g, " ")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l !== "" && !l.startsWith("#"));

describe("the release image's Dockerfile (REQ-GEN-09)", () => {
  it("REQ-GEN-09/AC1+AC6: it is built from the context's tarballs and lockfile, never from the repository", () => {
    // A base pinned by digest: the tag alone could serve another image tomorrow.
    expect(instructions.find((l) => l.startsWith("FROM "))).toMatch(
      /^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}$/,
    );
    const copies = instructions
      .filter((l) => /^(COPY|ADD) /.test(l))
      .map((l) => l.split(/\s+/).slice(1, -1).join(" "));
    expect(copies).toEqual(["package.json package-lock.json image.json", "demo", "entrypoint.sh"]);
    expect(instructions.some((l) => l.startsWith("ADD "))).toBe(false);
    // The tarballs are mounted for the install only: they never become a layer.
    const install = instructions.find((l) => l.includes("npm ci"));
    expect(install).toMatch(/^RUN --mount=type=bind,source=tarballs,target=\/opt\/qajitsu\/tarballs /);
    expect(install).toMatch(/npm ci --ignore-scripts --omit=dev/);
    expect(install).toContain("chmod 0444 image.json");
    expect(dockerfile).not.toMatch(/npm install/);
    expect(dockerfile).not.toMatch(/plugin add/);
  });

  it("REQ-GEN-09/AC6: it runs as an unprivileged user and bakes in no secret", () => {
    const users = instructions.filter((l) => l.startsWith("USER "));
    expect(users).toEqual(["USER qa"]);
    expect(instructions.some((l) => /useradd --uid 10001\b/.test(l))).toBe(true);
    const env = instructions.filter((l) => /^(ENV|ARG) /.test(l)).join(" ");
    expect(env).not.toMatch(/TOKEN|SECRET|PASSWORD|API_KEY/i);
    expect(env).toContain("QAJITSU_IMAGE=ghcr.io/bogiloco/qajitsu:${VERSION}");
    expect(instructions.filter((l) => l.startsWith("ARG ")).map((l) => l.split(/[\s=]/)[1])).toEqual([
      "VERSION",
      "REVISION",
    ]);
  });

  it("REQ-GEN-09/AC4: it carries the release's version, commit and licence as labels", () => {
    for (const label of [
      'org.opencontainers.image.version="${VERSION}"',
      'org.opencontainers.image.revision="${REVISION}"',
      'org.opencontainers.image.source="https://github.com/BogiLoco/qajitsu"',
      'org.opencontainers.image.licenses="Apache-2.0"',
    ])
      expect(dockerfile).toContain(label);
  });

  it("REQ-GEN-09/AC5: `demo` runs the offline demo; anything else is a qajitsu command, under an init process", () => {
    expect(instructions).toContain('ENTRYPOINT ["tini", "--", "qajitsu-entrypoint"]');
    expect(entrypoint).toContain('exec node /opt/qajitsu/demo/scripts/demo.mjs "$@"');
    expect(entrypoint).toContain('exec qajitsu "$@"');
    expect(entrypoint).toMatch(/^#!\/bin\/sh\n/);
    expect(entrypoint).toContain("set -eu");
  });
});
