import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitExec, createGitRepos, splitCredentials, type GitExec } from "./git-repos.js";

const exec = createGitExec({ PATH: process.env["PATH"] ?? "", HOME: tmpdir() });
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec(args, { cwd })).stdout.trim();

describe("git repos (REQ-CTX-04)", () => {
  let dir: string;
  let origin: string;
  let first: string;
  let second: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qj-git-"));
    origin = join(dir, "origin");
    await exec(["init", "-q", "-b", "main", origin]);
    const commit = async (content: string): Promise<string> => {
      await writeFile(join(origin, "app.txt"), content);
      await git(origin, "add", ".");
      await git(
        origin,
        "-c",
        "user.name=qa",
        "-c",
        "user.email=qa@example.com",
        "commit",
        "-q",
        "-m",
        content,
      );
      return git(origin, "rev-parse", "HEAD");
    };
    first = await commit("v1");
    second = await commit("v2");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("REQ-CTX-04/AC1+AC2: mirrors once, updates incrementally and checks out the exact SHA", async () => {
    const repos = createGitRepos({ cacheDir: join(dir, "cache"), exec });
    const url = pathToFileURL(origin).href;
    const mirror = await repos.ensureMirror("local", "demo-org/shop", url);
    expect(mirror).toBe(join(dir, "cache", "local", "demo-org/shop.git"));

    const wt1 = await repos.addWorktree(mirror, first, join(dir, "run", "repos", "shop"), url);
    expect(await readFile(join(wt1, "app.txt"), "utf8")).toBe("v1");

    await writeFile(join(origin, "app.txt"), "v3");
    await git(origin, "-c", "user.name=qa", "-c", "user.email=qa@example.com", "commit", "-qam", "v3");
    const third = await git(origin, "rev-parse", "HEAD");
    await repos.ensureMirror("local", "demo-org/shop", url);
    const wt3 = await repos.addWorktree(mirror, third, join(dir, "run2", "repos", "shop"), url);
    expect(await git(wt3, "rev-parse", "HEAD")).toBe(third);
    expect(second).not.toBe(third);
  });

  it("REQ-VER-11/AC1: finds the commit a change branched from (the version before the fix)", async () => {
    // main: first, second; fix branch from second with one commit; main moves on afterwards.
    await git(origin, "checkout", "-qb", "fix/SHOP-1");
    await writeFile(join(origin, "fix.txt"), "fix");
    await git(origin, "add", ".");
    await git(origin, "-c", "user.name=qa", "-c", "user.email=qa@example.com", "commit", "-qm", "fix");
    const fix = await git(origin, "rev-parse", "HEAD");
    await git(origin, "checkout", "-q", "main");
    await writeFile(join(origin, "later.txt"), "later");
    await git(origin, "add", ".");
    await git(origin, "-c", "user.name=qa", "-c", "user.email=qa@example.com", "commit", "-qm", "later");
    const repos = createGitRepos({ cacheDir: join(dir, "cache"), exec });
    const mirror = await repos.ensureMirror("local", "demo-org/shop", pathToFileURL(origin).href);
    expect(await repos.mergeBase(mirror, fix, "main")).toBe(second);
    await expect(repos.mergeBase(mirror, fix, "--upload-pack=x")).rejects.toMatchObject({
      code: "GIT_REF_INVALID",
    });
    await expect(repos.mergeBase(mirror, "nope", "main")).rejects.toMatchObject({ code: "GIT_SHA_INVALID" });
    await expect(repos.mergeBase(mirror, fix, "no-such-branch")).rejects.toMatchObject({
      code: "GIT_FAILED",
    });
  });

  it("REQ-CTX-04/AC2: an unknown SHA fails with GIT_SHA_MISSING; malformed input is rejected", async () => {
    const repos = createGitRepos({ cacheDir: join(dir, "cache"), exec });
    const url = pathToFileURL(origin).href;
    const mirror = await repos.ensureMirror("local", "demo-org/shop", url);
    await expect(repos.addWorktree(mirror, "f".repeat(40), join(dir, "wt"), url)).rejects.toMatchObject({
      code: "GIT_SHA_MISSING",
    });
    await expect(repos.addWorktree(mirror, "main", join(dir, "wt"), url)).rejects.toMatchObject({
      code: "GIT_SHA_INVALID",
    });
    await expect(repos.ensureMirror("local", "../../etc", url)).rejects.toMatchObject({
      code: "GIT_PATH_INVALID",
    });
  });

  it("clone failures are adapter errors without credentials in the message", async () => {
    const repos = createGitRepos({ cacheDir: join(dir, "cache"), exec });
    const error = await repos
      .ensureMirror("local", "demo-org/missing", "https://user:sup3r-secret@127.0.0.1:9/none.git")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "GIT_FAILED" });
    expect(JSON.stringify(error) + String(error)).not.toContain("sup3r-secret");
  });

  it("passes credentials through environment, never through arguments", async () => {
    const calls: { args: readonly string[]; env: Readonly<Record<string, string>> | undefined }[] = [];
    const recording: GitExec = (args, options) => {
      calls.push({ args, env: options?.env });
      return Promise.resolve({ stdout: "", stderr: "" });
    };
    const repos = createGitRepos({ cacheDir: join(dir, "c2"), exec: recording });
    await repos.ensureMirror(
      "github",
      "example-org/shop-web",
      "https://x-access-token:tok-123456@github.com/example-org/shop-web.git",
    );
    expect(calls[0]?.args).toEqual([
      "clone",
      "--mirror",
      "--",
      "https://github.com/example-org/shop-web.git",
      join(dir, "c2", "github", "example-org/shop-web.git"),
    ]);
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain("tok-123456");
    expect(calls[0]?.env?.["GIT_CONFIG_VALUE_0"]).toBe(
      `Authorization: Basic ${Buffer.from("x-access-token:tok-123456").toString("base64")}`,
    );
  });

  it("splitCredentials leaves plain URLs and non-URLs alone", () => {
    expect(splitCredentials("https://github.com/a/b.git")).toEqual({
      url: "https://github.com/a/b.git",
      env: {},
    });
    expect(splitCredentials("/local/path")).toEqual({ url: "/local/path", env: {} });
  });
});
