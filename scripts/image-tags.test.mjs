import { describe, expect, it } from "vitest";
import { RELEASE_IMAGE, SIGNER, imageNotes, imageNotesRefusal, withImageNotes } from "./github-release.mjs";
import { DEMO_FILES, IMAGE_PLUGINS, demoFileAllowed, imagePackages } from "./image-context.mjs";
import { imageTags, laterTags } from "./image-tags.mjs";

describe("release image: tags, notes and contents (REQ-GEN-09)", () => {
  it("REQ-GEN-09/AC4: a release is tagged with its version, its minor line and latest; a pre-release only with itself", () => {
    expect(imageTags("0.2.1")).toEqual(["0.2.1", "0.2", "latest"]);
    expect(imageTags("1.10.0")).toEqual(["1.10.0", "1.10", "latest"]);
    expect(imageTags("0.3.0-beta.1")).toEqual(["0.3.0-beta.1"]);
    expect(() => imageTags("latest")).toThrow(/not a release version/);
    expect(() => imageTags("v0.2.1")).toThrow(/not a release version/);
    // The minor line and latest move only after the image was verified; a pre-release moves neither.
    expect(laterTags("0.2.1")).toEqual(["0.2", "latest"]);
    expect(laterTags("0.3.0-beta.1")).toEqual([]);
  });

  it("REQ-GEN-09/AC3+AC4: the release notes name the image by digest and how to check its signature and provenance", () => {
    const digest = `sha256:${"ab".repeat(32)}`;
    const notes = imageNotes("ghcr.io/bogiloco/qajitsu", digest, ["0.2.1", "0.2", "latest"]);
    expect(notes).toContain(
      `\`ghcr.io/bogiloco/qajitsu@${digest}\` (tags \`0.2.1\`, \`0.2\`, \`latest\`; amd64 and arm64)`,
    );
    expect(notes).toContain(`cosign verify ghcr.io/bogiloco/qajitsu@${digest}`);
    // Only the Release workflow on main, run by a push, verifies; a regex or another workflow of the repository does not.
    expect(notes).toContain(`--certificate-identity ${SIGNER}`);
    expect(SIGNER).toBe(
      "https://github.com/BogiLoco/qajitsu/.github/workflows/image-publish.yml@refs/heads/main",
    );
    expect(notes).not.toContain("regexp");
    expect(notes).toContain("--certificate-github-workflow-ref refs/heads/main");
    expect(notes).toContain("--certificate-github-workflow-trigger push");
    expect(notes).toContain(
      "--signer-workflow BogiLoco/qajitsu/.github/workflows/image-publish.yml --source-ref refs/heads/main --deny-self-hosted-runners",
    );
    expect(notes).toContain(`-e QAJITSU_IMAGE_DIGEST=${digest}`);
    expect(() => imageNotes("ghcr.io/bogiloco/qajitsu", "latest", [])).toThrow(/not an image digest/);
    // Running the image job again replaces the section instead of adding a second one.
    const once = withImageNotes("## Changes\n\n- a\n", notes);
    expect(withImageNotes(once, notes)).toBe(once);
    expect(once.match(/### Image/g)).toHaveLength(1);
    expect(once.startsWith("## Changes\n\n- a\n")).toBe(true);
    // Nothing unchecked reaches gh: a value that is not the CLI's release tag, or another image, is refused.
    expect(imageNotesRefusal("@qajitsu/cli@0.2.1", RELEASE_IMAGE)).toBeUndefined();
    expect(imageNotesRefusal("--repo=evil/x", RELEASE_IMAGE)).toBe(
      "--repo=evil/x is not a release tag of the CLI",
    );
    expect(imageNotesRefusal("@qajitsu/core@0.2.1", RELEASE_IMAGE)).toMatch(/not a release tag/);
    expect(imageNotesRefusal("@qajitsu/cli@0.2.1", "ghcr.io/evil/qajitsu")).toBe(
      "ghcr.io/evil/qajitsu is not ghcr.io/bogiloco/qajitsu",
    );
  });

  it("REQ-GEN-09/AC5+AC6: the image gets the CLI's packages and the runner plugins, and the demo without builds or env files", () => {
    const manifests = new Map([
      ["@qajitsu/cli", { dependencies: { "@qajitsu/core": "0.1.0" } }],
      ["@qajitsu/core", {}],
      ["@qajitsu/adapter-runner-api", { dependencies: { "@qajitsu/core": "0.1.0" } }],
      ["@qajitsu/adapter-runner-web", {}],
      ["@qajitsu/adapter-ticket-jira", {}],
    ]);
    expect(imagePackages(manifests)).toEqual({
      cli: ["@qajitsu/cli", "@qajitsu/core"],
      plugins: ["@qajitsu/adapter-runner-api", "@qajitsu/adapter-runner-web"],
      // Everything installed, the plugins' own QAJitsu packages included.
      all: ["@qajitsu/adapter-runner-api", "@qajitsu/adapter-runner-web", "@qajitsu/cli", "@qajitsu/core"],
    });
    expect(IMAGE_PLUGINS).toEqual(["runner-api", "runner-web"]);
    expect(DEMO_FILES).toContain("scripts/demo.mjs");
    for (const ok of [
      "examples/demo-shop/api/server.mjs",
      "examples/demo-shop/.env.example",
      "fixtures/specs/demo-1/TC-01.spec.ts",
    ])
      expect(demoFileAllowed(ok), ok).toBe(true);
    for (const no of [
      "examples/demo-shop/.env",
      "examples/demo-shop/.env.local",
      "examples/demo-shop/node_modules/x/index.js",
      "examples/demo-shop/android/build/outputs/app.apk",
      "examples/demo-shop/.qa-runs/r1/run.json",
      "examples/demo-shop/android/.gradle/cache",
    ])
      expect(demoFileAllowed(no), no).toBe(false);
  });
});
