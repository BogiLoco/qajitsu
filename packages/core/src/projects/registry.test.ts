import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listProjects,
  projectPaths,
  qajitsuHome,
  readActiveProject,
  registerProject,
  resolveProject,
  setActiveProject,
} from "./registry.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "qj-home-"));
  dirs.push(root);
  const home = join(root, ".qajitsu");
  const qa = async (name: string) => {
    const dir = join(root, name, ".qa");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "qa.project.yaml"), "project: x\n");
    return dir;
  };
  return { root, home, qa };
};

describe("project registry (REQ-PRJ-01..03, ADR-0006)", () => {
  it("REQ-PRJ-01/AC1: the QAJitsu home is ~/.qajitsu unless QAJITSU_HOME says otherwise", () => {
    expect(qajitsuHome({}, "/home/qa")).toBe("/home/qa/.qajitsu");
    expect(qajitsuHome({ QAJITSU_HOME: "/srv/qj" }, "/home/qa")).toBe("/srv/qj");
  });

  it("REQ-PRJ-01/AC2+AC3 + REQ-PRJ-02/AC1: registering creates the project home layout; slugs are validated", async () => {
    const { home, qa } = await setup();
    const record = await registerProject(home, {
      slug: "bank",
      qaDir: await qa("bank-app"),
      jiraPrefixes: ["BANK"],
    });
    expect(record).toMatchObject({ slug: "bank", jira_prefixes: ["BANK"] });
    expect((await readdir(join(home, "projects", "bank"))).sort()).toEqual(
      ["cache", "exports", "knowledge", "logs", "project.yaml", "runs"].sort(),
    );
    expect(projectPaths(home, "bank")).toMatchObject({
      runs: join(home, "projects", "bank", "runs"),
      gitCache: join(home, "projects", "bank", "cache", "git"),
      exports: join(home, "projects", "bank", "exports"),
    });
    for (const slug of ["Bank", "1bank", "b", "../evil", "a".repeat(41)])
      await expect(registerProject(home, { slug, qaDir: await qa("x") }), slug).rejects.toMatchObject({
        code: "PROJECT_SLUG_INVALID",
      });
  });

  it("REQ-PRJ-02/AC5: registering an existing slug changes nothing without force", async () => {
    const { home, qa } = await setup();
    await registerProject(home, { slug: "bank", qaDir: await qa("one"), jiraPrefixes: ["BANK"] });
    await expect(registerProject(home, { slug: "bank", qaDir: await qa("two") })).rejects.toMatchObject({
      code: "PROJECT_EXISTS",
    });
    const forced = await registerProject(home, { slug: "bank", qaDir: await qa("two"), force: true });
    expect(forced.qa_dir).toContain("two");
  });

  it("REQ-PRJ-03/AC1: the active project is set, read and must exist", async () => {
    const { home, qa } = await setup();
    expect(await readActiveProject(home)).toBeUndefined();
    await registerProject(home, { slug: "bank", qaDir: await qa("bank") });
    await setActiveProject(home, "bank");
    expect(await readActiveProject(home)).toBe("bank");
    await expect(setActiveProject(home, "shop")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(await readFile(join(home, "config.yaml"), "utf8")).not.toMatch(/secret|token|password/i);
    expect((await listProjects(home)).map((p) => p.slug)).toEqual(["bank"]);
  });

  it("REQ-PRJ-03/AC2+AC3: flag, environment, ticket prefix, active project, in this order; an ambiguous prefix is an error", async () => {
    const { home, qa } = await setup();
    await registerProject(home, { slug: "bank", qaDir: await qa("bank"), jiraPrefixes: ["BANK"] });
    await registerProject(home, { slug: "shop", qaDir: await qa("shop"), jiraPrefixes: ["SHOP", "DEMO"] });
    await setActiveProject(home, "bank");
    const resolve = (o: Parameters<typeof resolveProject>[1]) =>
      resolveProject(home, o).then((r) => [r.slug, r.via]);
    expect(await resolve({ flag: "shop", env: "bank", ticket: "BANK-1" })).toEqual(["shop", "flag"]);
    expect(await resolve({ env: "shop", ticket: "BANK-1" })).toEqual(["shop", "QAJITSU_PROJECT"]);
    expect(await resolve({ ticket: "DEMO-12" })).toEqual(["shop", "ticket prefix DEMO"]);
    expect(await resolve({ ticket: "OTHER-1" })).toEqual(["bank", "active project"]);
    expect(await resolve({})).toEqual(["bank", "active project"]);
    await expect(resolveProject(home, { flag: "nope" })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await registerProject(home, { slug: "bank2", qaDir: await qa("bank2"), jiraPrefixes: ["BANK"] });
    await expect(resolveProject(home, { ticket: "BANK-7" })).rejects.toMatchObject({
      code: "PROJECT_PREFIX_AMBIGUOUS",
    });
  });

  it("REQ-PRJ-03/AC2: without any project the command fails instead of guessing", async () => {
    const { home } = await setup();
    await expect(resolveProject(home, { ticket: "BANK-1" })).rejects.toMatchObject({
      code: "PROJECT_NOT_SELECTED",
    });
  });
});
