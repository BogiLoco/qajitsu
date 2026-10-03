import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TicketKeySchema, createGitExec } from "@qajitsu/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalCodeHost } from "./local.js";

const exec = createGitExec({ PATH: process.env["PATH"] ?? "", HOME: tmpdir() });
const key = TicketKeySchema.parse("DEMO-1");

describe("local code host (REQ-NFR-04)", () => {
  let root: string;
  let repo: string;
  let featureSha: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qj-local-"));
    repo = join(root, "demo-org", "demo-shop");
    const g = (...args: string[]) =>
      exec(["-C", repo, "-c", "user.name=qa", "-c", "user.email=qa@example.com", ...args]);
    await exec(["init", "-q", "-b", "main", repo]);
    await writeFile(join(repo, "a.txt"), "1\n");
    await g("add", ".");
    await g("commit", "-qm", "init");
    await g("checkout", "-qb", "feature/DEMO-1-cart");
    await writeFile(join(repo, "a.txt"), "2\n");
    await g("commit", "-qam", "DEMO-1");
    featureSha = (await g("rev-parse", "HEAD")).stdout.trim();
    await g("checkout", "-q", "main");
    await g("branch", "feature/DEMO-10");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("REQ-CTX-03/AC2: finds branches mentioning the key, with exact SHA", async () => {
    const host = createLocalCodeHost({ alias: "local", root }, exec);
    const changes = await host.findChangesForTicket(key, ["demo-org/demo-shop"]);
    expect(changes).toEqual([
      {
        host: "local",
        repo: "demo-org/demo-shop",
        kind: "branch",
        id: "feature/DEMO-1-cart",
        sourceBranch: "feature/DEMO-1-cart",
        targetBranch: "main",
        headSha: featureSha,
        matchedBy: "branch",
      },
    ]);
    expect(await host.getDiff(changes[0]!)).toContain("+2");
    expect(await host.getReviewComments(changes[0]!)).toEqual([]);
    expect(await host.cloneUrl("demo-org/demo-shop")).toMatch(/^file:\/\//);
    expect(host.parseChangeUrl("https://x")).toBeUndefined();
  });

  it("REQ-CTX-03/AC3: resolves branches and SHAs; rejects PRs, option-like refs and unknown refs", async () => {
    const host = createLocalCodeHost({ alias: "local", root }, exec);
    expect(
      (await host.resolveChange({ repo: "demo-org/demo-shop", kind: "branch", id: "feature/DEMO-1-cart" }))
        .headSha,
    ).toBe(featureSha);
    expect(
      await host.resolveChange({ repo: "demo-org/demo-shop", kind: "branch", id: featureSha }),
    ).toMatchObject({ kind: "sha" });
    await expect(
      host.resolveChange({ repo: "demo-org/demo-shop", kind: "pr", id: "1" }),
    ).rejects.toMatchObject({ code: "LOCAL_REF_INVALID" });
    await expect(
      host.resolveChange({ repo: "demo-org/demo-shop", kind: "branch", id: "--output=x" }),
    ).rejects.toMatchObject({ code: "LOCAL_REF_INVALID" });
    await expect(
      host.resolveChange({ repo: "demo-org/demo-shop", kind: "branch", id: "nope" }),
    ).rejects.toMatchObject({ code: "LOCAL_GIT_FAILED" });
    await expect(host.findChangesForTicket(key, ["../x"])).rejects.toMatchObject({
      code: "LOCAL_REPO_INVALID",
    });
  });
});
