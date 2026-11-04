import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { sameImage, summarise } from "./oci-archive.mjs";

const files = {
  "index.json": JSON.stringify({ manifests: [{ digest: "sha256:aaa" }] }),
  "blobs/sha256/aaa": JSON.stringify({
    manifests: [
      { digest: "sha256:m1", platform: { os: "linux", architecture: "amd64" } },
      { digest: "sha256:m2", platform: { os: "linux", architecture: "arm64", variant: "v8" } },
      { digest: "sha256:att", platform: { os: "unknown", architecture: "unknown" } },
    ],
  }),
  "blobs/sha256/m1": JSON.stringify({ config: { digest: "sha256:c1" } }),
  "blobs/sha256/m2": JSON.stringify({ config: { digest: "sha256:c2" } }),
};
const read = (path) => {
  const f = files[path];
  if (f === undefined) throw new Error(`no ${path}`);
  return f;
};

describe("the OCI archive of the release image (REQ-GEN-09)", () => {
  it("REQ-GEN-09/AC1+AC2: the digest it is pushed with, and each platform's manifest and config; attestations left out", () => {
    expect(summarise(read)).toEqual({
      index: "sha256:aaa",
      platforms: {
        "linux/amd64": { manifest: "sha256:m1", config: "sha256:c1" },
        "linux/arm64/v8": { manifest: "sha256:m2", config: "sha256:c2" },
      },
    });
  });

  it("REQ-GEN-09/AC1: the image that was checked must be the one that is published", () => {
    const summary = summarise(read);
    expect(sameImage(summary, "linux/amd64", "sha256:c1")).toBeUndefined();
    expect(sameImage(summary, "linux/amd64", "sha256:other")).toBe(
      "the checked linux/amd64 image is sha256:other, the archive holds sha256:c1",
    );
    expect(sameImage(summary, "linux/s390x", "sha256:c1")).toBe(
      "the archive has no linux/s390x image (it has linux/amd64, linux/arm64/v8)",
    );
  });

  it("REQ-GEN-09/AC1: an archive with no image, two images or a single-platform image is refused", () => {
    expect(() => summarise(() => JSON.stringify({ manifests: [] }))).toThrow(/exactly one image/);
    expect(() =>
      summarise(() => JSON.stringify({ manifests: [{ digest: "sha256:a" }, { digest: "sha256:b" }] })),
    ).toThrow(/exactly one image/);
    const single = { ...files, "blobs/sha256/aaa": JSON.stringify({ config: { digest: "sha256:c" } }) };
    expect(() => summarise((p) => single[p])).toThrow(/not a multi-platform index/);
  });

  describe("from the command line", () => {
    const work = mkdtempSync(join(tmpdir(), "oci-archive-"));
    afterAll(() => rmSync(work, { recursive: true, force: true }));
    const c1 = `sha256:${"1".repeat(64)}`;
    const layout = {
      "index.json": JSON.stringify({ manifests: [{ digest: "sha256:aaa" }] }),
      "blobs/sha256/aaa": JSON.stringify({
        manifests: [{ digest: "sha256:m1", platform: { os: "linux", architecture: "amd64" } }],
      }),
      "blobs/sha256/m1": JSON.stringify({ config: { digest: c1 } }),
    };
    for (const [path, text] of Object.entries(layout)) {
      mkdirSync(dirname(join(work, "oci", path)), { recursive: true });
      writeFileSync(join(work, "oci", path), text);
    }
    const archive = join(work, "image.tar");
    spawnSync("tar", ["-cf", archive, "-C", join(work, "oci"), "index.json", "blobs"]);
    const cli = (...args) =>
      spawnSync("node", [fileURLToPath(new URL("./oci-archive.mjs", import.meta.url)), archive, ...args], {
        encoding: "utf8",
      });

    it("REQ-GEN-09/AC1: the checked config passes; another one, or none at all, fails the step", () => {
      expect(cli("linux/amd64", c1).status).toBe(0);
      expect(cli("--index").stdout).toBe("sha256:aaa\n");
      expect(cli("linux/amd64", `sha256:${"2".repeat(64)}`).status).toBe(1);
      // `docker image inspect` that failed and printed nothing: never a passing check.
      const empty = cli("linux/amd64", "");
      expect(empty.status).toBe(1);
      expect(empty.stderr).toContain("no config digest given for linux/amd64");
      expect(cli("linux/amd64").status).toBe(1);
      expect(cli("linux/arm64", c1).status).toBe(1);
    });
  });
});
