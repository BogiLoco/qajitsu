import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelRegistry } from "@qajitsu/models";
import type { ToolId } from "@qajitsu/toolchain";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedModel, type Turn } from "../../../../tests/support/mock-model.js";
import { runDoctorRecommend } from "./doctor-recommend.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const shop = async () => {
  const root = await mkdtemp(join(tmpdir(), "qj-doctor-recommend-"));
  dirs.push(root);
  for (const [path, text] of Object.entries({
    "package.json": JSON.stringify({ dependencies: { vue: "^3" } }),
    "compose.yaml": "services: { api: { image: shop } }",
    "api/openapi.yaml": "openapi: 3.1.0",
  })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
};
const registry = (turns: Turn[]) => {
  const model = scriptedModel(turns);
  const models = {
    forRole: () => Promise.resolve({ ...model, id: "mock/scripted" }),
    resolve: () => Promise.resolve({ ...model, id: "mock/scripted" }),
  } as unknown as ModelRegistry;
  return { models, model };
};
const io = (answers: string[] = [], ask = true) => {
  let out = "";
  let err = "";
  return {
    io: {
      write: (t: string) => (out += t),
      writeError: (t: string) => (err += t),
      cwd: "/",
      ...(ask ? { ask: () => Promise.resolve(answers.shift() ?? "") } : {}),
    },
    out: () => out,
    err: () => err,
  };
};
const run = async (
  root: string,
  options: { yes?: boolean; offline?: boolean },
  models: ModelRegistry | undefined,
  answers: string[] = [],
  ask = true,
) => {
  const installed: [ToolId[], boolean][] = [];
  const t = io(answers, ask);
  const code = await runDoctorRecommend(options, t.io, {
    root,
    ...(models ? { models } : {}),
    host: { os: "linux" },
    mask: (s) => s,
    setup: (tools, yes) => {
      installed.push([[...tools], yes]);
      return Promise.resolve(0);
    },
  });
  return { code, out: t.out(), err: t.err(), installed };
};

describe("qj doctor --recommend (REQ-GEN-13)", () => {
  it("REQ-GEN-13/AC5: offline, the findings alone give a recommendation marked as such", async () => {
    const r = await run(await shop(), { offline: true }, undefined, [], false);
    expect(r.code).toBe(0);
    expect(r.out).toContain("F1 web-framework: vue in package.json");
    expect(r.out).toContain("Recommendation from the files found by code (no model asked):");
    expect(r.out).toContain("Command: qj setup --only browsers,docker");
    expect(r.out).toContain("Nothing installed.");
    expect(r.installed).toEqual([]);
  });

  it("REQ-GEN-13/AC2: a model's recommendation is used after code checked it; what it may not propose is dropped and said", async () => {
    const { models, model } = registry([
      {
        text: JSON.stringify({
          install: [
            { tool: "browsers", why: "Vue front-end", basis: ["F1"] },
            { tool: "java", why: "just in case", basis: ["F1"] },
          ],
          skip: [{ tool: "docker", why: "compose only for local development" }],
          settings: [{ key: "openapi", value: "api/openapi.yaml", why: "API description", basis: ["F2"] }],
        }),
      },
    ]);
    const r = await run(await shop(), {}, models, ["n"]);
    expect(model.mock.doGenerateCalls).toHaveLength(1);
    expect(r.out).toContain("Recommendation (a model's proposal, every basis checked by code):");
    expect(r.out).toContain("dropped from the model's proposal: java: no finding supports it");
    expect(r.out).toMatch(/docker\s+compose only for local development/);
    expect(r.out).toContain("Command: qj setup --only browsers");
    expect(r.installed).toEqual([]);
  });

  it("REQ-GEN-13/AC4: nothing is installed without a yes; yes installs the set; --yes installs it in CI", async () => {
    const root = await shop();
    expect((await run(root, { offline: true }, undefined, ["y"])).installed).toEqual([
      [["browsers", "docker"], false],
    ]);
    expect((await run(root, { offline: true, yes: true }, undefined, [], false)).installed).toEqual([
      [["browsers", "docker"], true],
    ]);
  });

  it("REQ-GEN-13/AC5: a model that gives no usable answer leaves the findings to decide", async () => {
    const { models } = registry([{ text: "not json" }, { text: "still not" }, { text: "no" }]);
    const r = await run(await shop(), {}, models, [], false);
    expect(r.err).toContain("gave no usable recommendation");
    expect(r.out).toContain("Recommendation from the files found by code (no model asked):");
  });
});
