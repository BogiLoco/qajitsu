// The release pipeline of the repository (REQ-GEN-15): what it runs, in which order, with which rights.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, unknown>;
}
interface Job {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly environment?: string;
  readonly permissions?: Record<string, string>;
  readonly outputs?: Record<string, string>;
  readonly env?: Record<string, string>;
  /** A job that calls a reusable workflow has no steps. */
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly steps?: readonly Step[];
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly defaults?: unknown;
  readonly permissions?: Record<string, string>;
  readonly concurrency?: { readonly group?: string; readonly "cancel-in-progress"?: boolean };
  readonly jobs: Record<string, Job>;
}

const workflow = (name: string): Workflow =>
  parse(readFileSync(join(root, ".github", "workflows", name), "utf8")) as Workflow;
const scripts = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }
).scripts;
const WORKFLOWS = ["release.yml", "image-publish.yml", "ci.yml"];
const index = (steps: readonly Step[], match: (s: Step) => boolean): number => steps.findIndex(match);
const secretsIn = (value: unknown): boolean => JSON.stringify(value ?? {}).includes("secrets.");

describe("the release workflow (REQ-GEN-15/AC1+AC2)", () => {
  const release = workflow("release.yml");
  const test = release.jobs["test"];
  const versionJob = release.jobs["version"];
  const publishJob = release.jobs["release"];
  const steps = publishJob?.steps ?? [];
  const changesets = versionJob?.steps?.find((s) => s.uses?.startsWith("changesets/action@"));
  const decide = steps.find((s) => s.id === "decide");
  const publish = steps.find((s) => s.run === "pnpm release");
  const githubRelease = steps.find((s) => s.run === "node scripts/github-release.mjs");

  it("REQ-GEN-15/AC2: it runs on main only, one at a time, never for a pull request or a fork", () => {
    expect(Object.keys(release.on)).toEqual(["push"]);
    expect(release.on["push"]).toEqual({ branches: ["main"] });
    expect(release.concurrency).toEqual({ group: "release", "cancel-in-progress": false });
    expect(test?.if).toBe("github.repository == 'BogiLoco/qajitsu'");
    expect(versionJob?.needs).toBe("test");
    expect(publishJob?.needs).toBe("version");
    expect(publishJob?.if).toBe("needs.version.outputs.has-changesets == 'false'");
  });

  it("REQ-GEN-15/AC2: everything that runs dependency code does so without write rights or secrets", () => {
    expect(release.permissions).toEqual({ contents: "read" });
    expect(test?.permissions).toEqual({ contents: "read" });
    expect(test?.environment).toBeUndefined();
    for (const step of test?.steps ?? []) expect(secretsIn(step), JSON.stringify(step)).toBe(false);
    const node = test?.steps?.find((s) => s.uses?.startsWith("actions/setup-node@"));
    expect(node?.with?.["cache"]).toBeUndefined();
    const run = (test?.steps ?? []).map((s) => s.name ?? s.run ?? s.uses ?? "");
    const at = [
      "pnpm install --frozen-lockfile",
      "pnpm verify",
      "pnpm build",
      "plugins as installed",
      "node scripts/release-check.mjs",
    ].map((r) => run.indexOf(r));
    expect(
      at.every((i) => i >= 0),
      run.join(" | "),
    ).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(test?.steps?.find((s) => s.name === "plugins as installed")?.env).toEqual({
      QAJITSU_E2E_NETWORK: "1",
    });
  });

  it("REQ-GEN-15/AC2: no checkout of any workflow leaves the token in the repository's git config", () => {
    for (const name of WORKFLOWS)
      for (const [id, job] of Object.entries(workflow(name).jobs))
        for (const step of job.steps ?? [])
          if (step.uses?.startsWith("actions/checkout@") === true)
            expect(step.with?.["persist-credentials"], `${name} ${id}`).toBe(false);
  });

  it("REQ-GEN-15/AC2: the version pull request job can push its branch, and holds no npm or OIDC token", () => {
    expect(versionJob?.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    expect(versionJob?.environment).toBeUndefined();
    expect(versionJob?.outputs).toEqual({
      "has-changesets": "${{ steps.changesets.outputs.hasChangesets }}",
    });
    for (const step of versionJob?.steps ?? []) expect(JSON.stringify(step)).not.toContain("NPM_TOKEN");
    expect(changesets?.env).toEqual({
      GITHUB_TOKEN: "${{ secrets.RELEASE_PR_TOKEN || secrets.GITHUB_TOKEN }}",
    });
    expect(versionJob?.steps?.map((s) => s.run).filter(Boolean)).toEqual([
      "pnpm install --frozen-lockfile --ignore-scripts",
    ]);
  });

  it("REQ-GEN-15/AC2: the release job holds the rights and the token, each step only what it needs", () => {
    expect(publishJob?.environment).toBe("npm-publish");
    expect(publishJob?.permissions).toEqual({ contents: "write", "id-token": "write" });
    expect(steps.find((s) => s.uses?.startsWith("actions/checkout@"))?.with).toMatchObject({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(steps.some((s) => s.uses?.startsWith("changesets/action@") === true)).toBe(false);
    // The npm token reaches the publish step only, never the decision or the install.
    for (const step of steps) {
      const npmToken = JSON.stringify(step.env ?? {}).includes("NPM_TOKEN");
      expect(npmToken, JSON.stringify(step)).toBe(step === publish);
    }
    expect(publish?.env).toEqual({
      NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
      NPM_CONFIG_PROVENANCE: "true",
    });
    expect(githubRelease?.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    expect(index(steps, (s) => s === githubRelease)).toBeGreaterThan(index(steps, (s) => s === publish));
  });

  it("REQ-GEN-15/AC2: it publishes only when none of the new versions is in the registry, decided before any install", () => {
    expect(decide?.run).toBe("node scripts/unpublished-check.mjs");
    const install = index(steps, (s) => s.run?.startsWith("pnpm install") === true);
    expect(index(steps, (s) => s === decide)).toBeGreaterThan(-1);
    expect(index(steps, (s) => s === decide)).toBeLessThan(install);
    expect(index(steps, (s) => s === decide)).toBe(
      index(steps, (s) => s.uses?.startsWith("actions/setup-node@") === true) + 1,
    );
    for (const step of steps.slice(index(steps, (s) => s === decide) + 1))
      expect(step.if, JSON.stringify(step)).toBe("steps.decide.outputs.publish == 'true'");
    // The decision imports nothing but node and this repository's dependency-free release and provenance checks.
    for (const file of ["unpublished-check.mjs", "release-check.mjs", "provenance-check.mjs"]) {
      const imports = [
        ...readFileSync(join(root, "scripts", file), "utf8").matchAll(/^import .* from "([^"]+)";$/gm),
      ];
      for (const m of imports)
        expect(m[1], file).toMatch(/^(node:|\.\/release-check\.mjs$|\.\/provenance-check\.mjs$)/);
    }
    // A release finished by this run accepts, in both provenance checks, exactly the runs the decision named.
    expect(steps.find((s) => s.name === "provenance of what was published")?.env).toEqual({
      EARLIER_RUNS: "${{ steps.decide.outputs.earlier-runs }}",
    });
    const imageBuild = release.jobs["image-build"]?.steps ?? [];
    expect(imageBuild.find((s) => s.name === "provenance of the tarballs")?.env).toEqual({
      EARLIER_RUNS: "${{ needs.release.outputs.earlier-runs }}",
    });
  });

  it("REQ-GEN-15/AC2: before anything is tagged, every package must carry this run's provenance", () => {
    const check = steps.find((s) => s.name === "provenance of what was published");
    expect(check?.run).toBe('node scripts/provenance-check.mjs "$GITHUB_RUN_ID" $EARLIER_RUNS');
    expect(index(steps, (s) => s === check)).toBeGreaterThan(index(steps, (s) => s === publish));
    expect(index(steps, (s) => s === check)).toBeLessThan(index(steps, (s) => s === githubRelease));
    const imports = [
      ...readFileSync(join(root, "scripts", "provenance-check.mjs"), "utf8").matchAll(
        /^import .* from "([^"]+)";$/gm,
      ),
    ];
    for (const m of imports) expect(m[1]).toMatch(/^(node:|\.\/release-check\.mjs$)/);
  });

  it("REQ-GEN-15/AC2: every action of every workflow is pinned to a commit; reusable workflows are this repository's", () => {
    for (const name of WORKFLOWS)
      for (const job of Object.values(workflow(name).jobs)) {
        if (job.uses !== undefined) expect(job.uses).toMatch(/^\.\/\.github\/workflows\/[\w-]+\.yml$/);
        for (const step of job.steps ?? [])
          if (step.uses !== undefined) expect(step.uses, step.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
      }
  });

  it("REQ-GEN-15/AC2: every Linux job runs on a pinned runner image, never on one that moves under the release", () => {
    // ubuntu-latest moved to a new Ubuntu while a release ran, and its package mirrors did not resolve there.
    for (const name of WORKFLOWS) {
      const text = readFileSync(join(root, ".github", "workflows", name), "utf8");
      expect(text, name).not.toContain("ubuntu-latest");
      for (const [id, job] of Object.entries(workflow(name).jobs)) {
        const runsOn = (job as { "runs-on"?: string })["runs-on"];
        if (runsOn !== undefined && !runsOn.includes("matrix.") && !runsOn.startsWith("macos"))
          expect(runsOn, `${name} ${id}`).toMatch(/^ubuntu-\d{2}\.\d{2}$/);
      }
    }
  });

  it("REQ-GEN-15/AC1: the version pull request is made by code: versions, changelogs, plugin catalogue, lockfile", () => {
    expect(changesets?.id).toBe("changesets");
    // The action publishes nothing itself: publishing is another job, with its own token.
    expect(changesets?.with).toEqual({
      version: "pnpm version-packages",
      title: "chore(release): version packages",
      commit: "chore(release): version packages",
    });
    const version = scripts["version-packages"] ?? "";
    const order = [
      "changeset version",
      "scripts/plugin-catalogue.mjs",
      "pnpm install --lockfile-only",
      "prettier --write",
    ];
    const at = order.map((part) => version.indexOf(part));
    expect(
      at.every((i) => i >= 0),
      version,
    ).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("REQ-GEN-15/AC1: all packages version together, so every later release is one version too", () => {
    const config = JSON.parse(readFileSync(join(root, ".changeset", "config.json"), "utf8")) as {
      fixed?: unknown;
    };
    expect(config.fixed).toEqual([["@qajitsu/*"]]);
  });

  it("REQ-GEN-15/AC2+AC3: publishing is guarded, from a clean build, after an inspection, by pnpm, then tagged", () => {
    const parts = (scripts["release"] ?? "").split("&&").map((s) => s.trim());
    expect(parts).toEqual([
      "node scripts/publish-guard.mjs",
      "pnpm clean",
      "pnpm build",
      // The full check, installs included, ran in the test job; here the published build is inspected again.
      "node scripts/release-check.mjs --no-install",
      // pnpm, not npm: only pnpm turns `workspace:` ranges into the released versions.
      'pnpm -r --filter "./packages/**" publish --access public --no-git-checks',
      "node scripts/release-tags.mjs",
    ]);
  });

  it("REQ-GEN-15/AC2: pnpm accepts the publish command as the release runs it", () => {
    // Run for real against no package at all, so only the options are checked: an option pnpm does not know fails
    // the release after its build, as `--workspace-concurrency` once did.
    const publish = (scripts["release"] ?? "")
      .split("&&")
      .map((s) => s.trim())
      .find((s) => s.includes(" publish "));
    expect(publish).toBeDefined();
    const args = (publish ?? "")
      .replace('--filter "./packages/**"', "--filter ./does-not-exist/**")
      .split(/\s+/)
      .slice(1);
    expect(args).toContain("./does-not-exist/**");
    const r = spawnSync("pnpm", [...args, "--dry-run"], { cwd: root, encoding: "utf8" });
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/Unknown option/);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    // The probe itself is not vacuous: an unknown option does fail.
    const bad = spawnSync("pnpm", [...args, "--dry-run", "--no-such-option"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(bad.status).not.toBe(0);
  });

  it("REQ-GEN-15/AC2: a package published by hand is refused before it is packed", () => {
    const dirs = [
      ...readdirSync(join(root, "packages")).map((d) => join(root, "packages", d)),
      ...readdirSync(join(root, "packages", "adapters")).map((d) => join(root, "packages", "adapters", d)),
    ].filter((d) => existsSync(join(d, "package.json")));
    for (const dir of dirs) {
      const m = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        private?: boolean;
        scripts?: Record<string, string>;
      };
      if (m.private === true) continue;
      const guard = /^node (\S+publish-guard\.mjs)$/.exec(m.scripts?.["prepublishOnly"] ?? "");
      expect(guard, dir).not.toBeNull();
      expect(resolve(dir, guard?.[1] ?? ""), dir).toBe(join(root, "scripts", "publish-guard.mjs"));
    }
  });
});

describe("the release image (REQ-GEN-09)", () => {
  const release = workflow("release.yml");
  const imagePublish = workflow("image-publish.yml");
  const job = (name: string) => (name === "publish" ? imagePublish.jobs["publish"] : release.jobs[name]);
  const steps = (name: string) => job(name)?.steps ?? [];
  const named = (name: string, step: string) => steps(name).find((s) => s.name === step);
  const runs = (name: string) =>
    steps(name)
      .map((s) => s.run ?? "")
      .join("\n");
  const BINFMT =
    "tonistiigi/binfmt:qemu-v10.2.3@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0";
  const SIGNER = "https://github.com/BogiLoco/qajitsu/.github/workflows/image-publish.yml@refs/heads/main";

  it("REQ-GEN-09/AC1: the image of a version is built after that version was released, from its published tarballs", () => {
    expect(job("image-build")?.needs).toBe("release");
    expect(job("image-build")?.if).toBe("needs.release.outputs.version != ''");
    expect(job("release")?.outputs).toEqual({
      version: "${{ steps.github-release.outputs.version }}",
      tag: "${{ steps.github-release.outputs.tag }}",
      "earlier-runs": "${{ steps.decide.outputs.earlier-runs }}",
    });
    expect(named("image-build", "image context")?.run).toBe(
      'node scripts/image-context.mjs "$RUNNER_TEMP/image" --from-registry',
    );
    // Nothing of the checkout is built: its install only answers which versions the repository tests.
    const buildRuns = steps("image-build").map((s) => s.run ?? "");
    expect(buildRuns.filter((r) => r.startsWith("pnpm"))).toEqual([
      "pnpm install --frozen-lockfile --ignore-scripts",
    ]);
    expect(runs("image-build")).not.toMatch(/pnpm build|pnpm -r|npm pack/);
  });

  it("REQ-GEN-09/AC1: only tarballs this run published go into the image", () => {
    const order = steps("image-build").map((s) => s.name ?? "");
    expect(named("image-build", "provenance of the tarballs")?.run).toBe(
      'node scripts/provenance-check.mjs "$GITHUB_RUN_ID" $EARLIER_RUNS',
    );
    expect(order.indexOf("provenance of the tarballs")).toBeGreaterThan(-1);
    expect(order.indexOf("provenance of the tarballs")).toBeLessThan(order.indexOf("image context"));
  });

  it("REQ-GEN-09/AC2+AC3: amd64 and arm64 with an SBOM and full provenance, into an archive that is not pushed", () => {
    expect(named("image-build", "build")?.with).toMatchObject({
      file: "ci/docker/Dockerfile.release",
      platforms: "linux/amd64,linux/arm64",
      push: false,
      provenance: "mode=max",
      sbom: true,
    });
    expect(String(named("image-build", "build")?.with?.["outputs"])).toMatch(/^type=oci,dest=/);
    // Only the version and the commit are build arguments: provenance publishes every one of them.
    for (const step of ["build", "load amd64", "load arm64"])
      expect(named("image-build", step)?.with?.["build-args"], step).toBe(
        "VERSION=${{ env.VERSION }}\nREVISION=${{ github.sha }}\n",
      );
  });

  it("REQ-GEN-09/AC2+AC6: the emulator and the builder that make the image are pinned by digest", () => {
    for (const name of ["image-build", "image-verify"]) {
      const qemu = steps(name).find((s) => s.uses?.startsWith("docker/setup-qemu-action@") === true);
      expect(qemu?.with, name).toEqual({ image: BINFMT });
    }
    const buildx = steps("image-build").find(
      (s) => s.uses?.startsWith("docker/setup-buildx-action@") === true,
    );
    expect(buildx?.with?.["driver-opts"]).toMatch(/^image=moby\/buildkit:v[\d.]+@sha256:[0-9a-f]{64}$/);
  });

  it("REQ-GEN-09/AC1+AC6: both images in the archive are the images that were checked", () => {
    const check = named("image-build", "check the images in the archive")?.run ?? "";
    for (const platform of ["amd64", "arm64"])
      expect(check).toContain(
        `node scripts/oci-archive.mjs "$RUNNER_TEMP/image.tar" linux/${platform} "$(docker image inspect qajitsu-image-check:${platform} --format '{{.Id}}')"`,
      );
    expect(check).toContain('node scripts/image-check.mjs qajitsu-image-check:amd64 "$VERSION"');
    // arm64 cannot be run without emulation here, but every one of its layers is scanned.
    expect(check).toContain("node scripts/image-check.mjs --layers-only qajitsu-image-check:arm64");
    for (const platform of ["amd64", "arm64"])
      expect(named("image-build", `load ${platform}`)?.with).toMatchObject({
        platforms: `linux/${platform}`,
        load: true,
        tags: `qajitsu-image-check:${platform}`,
      });
    const order = steps("image-build").map((s) => s.name ?? s.id ?? "");
    expect(order.indexOf("check the images in the archive")).toBeLessThan(order.indexOf("archive digests"));
    expect(order.indexOf("archive digests")).toBeLessThan(order.indexOf("upload"));
  });

  it("REQ-GEN-09/AC3: the publish job gets the checked archive by artifact id and refuses other bytes", () => {
    expect(job("image-build")?.outputs).toEqual({
      "artifact-id": "${{ steps.upload.outputs.artifact-id }}",
      "archive-sha256": "${{ steps.archive.outputs.sha256 }}",
      "index-digest": "${{ steps.archive.outputs.index }}",
    });
    expect(job("image-publish")).toMatchObject({
      needs: ["release", "image-build"],
      uses: "./.github/workflows/image-publish.yml",
      with: {
        version: "${{ needs.release.outputs.version }}",
        "artifact-id": "${{ needs.image-build.outputs.artifact-id }}",
        "archive-sha256": "${{ needs.image-build.outputs.archive-sha256 }}",
        "index-digest": "${{ needs.image-build.outputs.index-digest }}",
      },
    });
    const download = steps("publish").find((s) => s.uses?.startsWith("actions/download-artifact@") === true);
    expect(download?.with?.["artifact-ids"]).toBe("${{ inputs.artifact-id }}");
    expect(download?.with?.["name"]).toBeUndefined();
    const checked = named("publish", "the checked archive")?.run ?? "";
    // Every check fails the step explicitly: `[[ ]]` alone does not stop an older bash under `set -e`.
    for (const check of [
      '[ "$(sha256sum "$archive" | cut -d\' \' -f1)" = "$ARCHIVE_SHA256" ] || fail',
      '[ "$(node scripts/oci-archive.mjs "$archive" --index)" = "$INDEX_DIGEST" ] || fail',
      "(-[0-9A-Za-z_.]+)?$ ]] || fail",
      "^sha256:[0-9a-f]{64}$ ]] || fail",
      "-eq 1 ] || fail",
    ])
      expect(checked, check).toContain(check);
    const order = steps("publish").map((s) => s.name ?? s.uses ?? "");
    expect(order.indexOf("the checked archive")).toBeLessThan(order.indexOf("push"));
    // The publish job accepts exactly the versions the tag and notes scripts accept, so nothing is pushed and signed
    // that `latest` and the release notes would then refuse.
    const pattern = /\[\[ "\$VERSION" =~ (\S+) \]\]/.exec(checked)?.[1] ?? "";
    const workflowAccepts = new RegExp(pattern);
    const tagsAccept = (v: string) => /^(\d+)\.(\d+)\.(\d+)(-[\w.]+)?$/.test(v);
    expect(readFileSync(join(root, "scripts", "image-tags.mjs"), "utf8")).toContain(
      "/^(\\d+)\\.(\\d+)\\.(\\d+)(-[\\w.]+)?$/",
    );
    for (const v of [
      "0.2.0",
      "1.0.0-rc.1",
      "1.0.0-rc_1",
      "1.0.0-rc-1",
      "1.0",
      "0.2.0;rm",
      "v1.0.0",
      "1.0.0-",
    ])
      expect(workflowAccepts.test(v), v).toBe(tagsAccept(v));
  });

  it("REQ-GEN-09/AC3: no dependency code runs where the image can be pushed, signed or attested", () => {
    expect(job("image-build")?.permissions).toEqual({ contents: "read" });
    expect(job("image-verify")?.permissions).toEqual({ contents: "read", packages: "read" });
    expect(job("image-notes")?.permissions).toEqual({ contents: "write" });
    const rights = { contents: "read", packages: "write", "id-token": "write", attestations: "write" };
    // The caller grants the rights; the reusable workflow itself grants nothing outside its one job.
    expect(job("image-publish")?.permissions).toEqual(rights);
    expect(imagePublish.permissions).toEqual({});
    expect(Object.keys(imagePublish.on)).toEqual(["workflow_call"]);
    expect(job("publish")?.permissions).toEqual(rights);
    expect(job("publish")?.environment).toBe("image-publish");
    expect(job("publish")?.if).toBe(
      "github.repository == 'BogiLoco/qajitsu' && github.ref == 'refs/heads/main' && github.event_name == 'push'",
    );
    expect(runs("publish")).not.toMatch(/pnpm|npm |docker run|docker build |docker buildx build|image-check/);
    // Inputs and the actor reach scripts as variables, never spliced into the script text.
    expect(runs("publish")).not.toContain("${{");
    for (const name of ["image-build", "publish", "image-verify", "image-notes"])
      for (const step of steps(name)) expect(secretsIn(step), `${name}: ${JSON.stringify(step)}`).toBe(false);
    expect(release.jobs["image-publish"]?.with).not.toHaveProperty("secrets");
    expect(release.jobs["image-publish"]).not.toHaveProperty("secrets");
  });

  it("REQ-GEN-09/AC3: the checked archive is pushed with its digests unchanged, signed recursively and attested", () => {
    const push = named("publish", "push")?.run ?? "";
    expect(push).toContain(
      'skopeo copy --all --preserve-digests "oci-archive:$ARCHIVE" "docker://$IMAGE:$VERSION"',
    );
    expect(push).toContain('= "$INDEX_DIGEST"');
    // Into Docker's config: the attestation push and `docker buildx imagetools` read that one.
    expect(push).toContain(
      'skopeo login --authfile "$HOME/.docker/config.json" ghcr.io --username "$ACTOR" --password-stdin',
    );
    // A version tag that holds another image is never overwritten; only "not there yet" lets the push go on.
    expect(push).toMatch(/if \[ "\$existing" != "\$INDEX_DIGEST" \]; then[\s\S]*exit 1/);
    expect(push).toContain('elif ! grep -qiE "manifest unknown|name unknown"');
    expect(push.indexOf("skopeo inspect --raw")).toBeLessThan(push.indexOf("skopeo copy"));
    expect(named("publish", "sign")?.run).toBe('cosign sign --yes --recursive "$IMAGE@$DIGEST"');
    expect(
      steps("publish").find((s) => s.uses?.startsWith("actions/attest-build-provenance@"))?.with,
    ).toEqual({
      "subject-name": "${{ env.IMAGE }}",
      "subject-digest": "${{ steps.push.outputs.digest }}",
      "push-to-registry": true,
    });
  });

  it("REQ-GEN-09/AC3: it is verified like a user verifies it: one signer, its attestation, an SBOM per platform", () => {
    const verify = named("publish", "verify the published image")?.run ?? "";
    expect(verify).toContain(`--certificate-identity "${SIGNER}"`);
    expect(verify).not.toContain("regexp");
    for (const flag of [
      "--certificate-github-workflow-repository BogiLoco/qajitsu",
      "--certificate-github-workflow-ref refs/heads/main",
      "--certificate-github-workflow-trigger push",
      "--signer-workflow BogiLoco/qajitsu/.github/workflows/image-publish.yml",
      "--source-ref refs/heads/main",
      "--deny-self-hosted-runners",
      "length == 2",
    ])
      expect(verify, flag).toContain(flag);
  });

  it("REQ-GEN-09/AC3: the release notes, the docs and the workflow name the same signer", () => {
    const notes = readFileSync(join(root, "scripts", "github-release.mjs"), "utf8");
    expect(/^export const SIGNER =\s*"([^"]+)";$/m.exec(notes)?.[1]).toBe(SIGNER);
    expect(notes).toContain("--signer-workflow BogiLoco/qajitsu/.github/workflows/image-publish.yml");
    const docs = readFileSync(join(root, "docs", "releasing.md"), "utf8");
    expect(docs).toContain(`--certificate-identity ${SIGNER}`);
    expect(docs).toContain("--signer-workflow BogiLoco/qajitsu/.github/workflows/image-publish.yml");
    expect(docs).not.toContain("workflows/release.yml@");
  });

  it("REQ-GEN-09/AC4: the minor line and latest move only after the verification, and the notes name the digest", () => {
    const order = steps("publish").map((s) => s.name ?? s.uses ?? "");
    expect(order.indexOf("move the tags")).toBeGreaterThan(order.indexOf("verify the published image"));
    const move = named("publish", "move the tags")?.run ?? "";
    expect(move).toContain('node scripts/image-tags.mjs "$IMAGE" "$VERSION" --later');
    expect(move).toContain('= "$DIGEST"');
    expect(job("image-publish")?.needs).toEqual(["release", "image-build"]);
    expect(job("image-notes")?.needs).toEqual(["release", "image-publish"]);
    const notes = named("image-notes", "release notes");
    expect(notes?.env).toMatchObject({
      TAG: "${{ needs.release.outputs.tag }}",
      DIGEST: "${{ needs.image-publish.outputs.digest }}",
    });
    expect(notes?.run).not.toContain("${{");
  });

  it("REQ-GEN-09/AC2+AC6: the published image is pulled by digest and run, on amd64 and arm64", () => {
    expect(job("image-verify")?.env).toMatchObject({ DIGEST: "${{ needs.image-publish.outputs.digest }}" });
    const run = named("image-verify", "run the published image")?.run ?? "";
    expect(run).toContain('docker pull "$IMAGE@$DIGEST"');
    expect(run).toContain('node scripts/image-check.mjs "$IMAGE@$DIGEST" "$VERSION"');
    expect(run).toContain("--platform linux/arm64");
  });

  it("REQ-GEN-09: every step of the release workflows fails on a failure inside a pipeline", () => {
    expect(release.defaults).toEqual({ run: { shell: "bash" } });
    expect(imagePublish.defaults).toEqual({ run: { shell: "bash" } });
  });

  it("REQ-GEN-09/AC4..AC6: every pull request builds the image and checks it, without pushing or credentials", () => {
    const ci = workflow("ci.yml").jobs["image"];
    const ciSteps = ci?.steps ?? [];
    for (const step of ciSteps) expect(secretsIn(step)).toBe(false);
    const ciRuns = ciSteps.map((s) => s.run ?? "");
    const context = ciRuns.findIndex((r) => r.startsWith("node scripts/image-context.mjs"));
    const docker = ciRuns.findIndex((r) => r.startsWith("docker build -f ci/docker/Dockerfile.release"));
    const check = ciRuns.findIndex((r) => r.startsWith("node scripts/image-check.mjs qajitsu-image-check"));
    expect(context).toBeGreaterThan(ciRuns.indexOf("pnpm build"));
    expect(docker).toBeGreaterThan(context);
    expect(check).toBeGreaterThan(docker);
    expect(ciRuns.some((r) => /docker push|--push|skopeo/.test(r))).toBe(false);
  });
});

describe("the release check on every pull request (REQ-GEN-15/AC5)", () => {
  it("REQ-GEN-15/AC5: CI builds and runs the release check for pull requests, without credentials", () => {
    const ci = workflow("ci.yml");
    expect(Object.keys(ci.on)).toContain("pull_request");
    const steps = ci.jobs["release-check"]?.steps ?? [];
    expect(steps.find((s) => s.uses?.startsWith("actions/checkout@"))?.with?.["persist-credentials"]).toBe(
      false,
    );
    for (const step of steps) expect(secretsIn(step)).toBe(false);
    const build = index(steps, (s) => s.run === "pnpm build");
    const check = index(steps, (s) => s.run === "node scripts/release-check.mjs");
    expect(build).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(build);
    expect(scripts["release:check"]).toBe("node scripts/release-check.mjs");
  });

  it("REQ-GEN-15/AC4: the check installs the CLI without running any install script", () => {
    const source = readFileSync(join(root, "scripts", "release-check.mjs"), "utf8");
    expect(source).toMatch(/"install",\s*"--no-audit",\s*"--no-fund",\s*"--ignore-scripts"/);
  });
});
