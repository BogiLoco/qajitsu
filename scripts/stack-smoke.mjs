#!/usr/bin/env node
// REQ-GEN-10/AC3..AC6: the stack as a user starts it, on a real engine with a real Ollama. A project is written,
// `qajitsu stack init` pins a QAJitsu image (from a local registry, so it has a digest) and the small preset's model,
// `compose up` pulls the models once, and QAJitsu runs inside the stack. Every check prints ok or the reason.
//
//   node scripts/stack-smoke.mjs <docker|podman> <image@sha256:...>
//
// Run after `pnpm build`; it removes its stack, volumes and folders at the end, also when a check fails.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The project the smoke test onboards: the auditor is off, so the small preset's model serves every role. */
export const SMOKE_PROJECT = [
  "project: smoke",
  "jira: { type: file, tickets_dir: ../tickets, project_key: SMOKE }",
  "code_hosts: { local: { type: local, root: ~/git } }",
  "repos: { shop: { host: local, path: smoke-org/shop } }",
  "knowledge: { embedding: ollama/all-minilm }",
  "verification: { auditor: off }",
  "environments: { allowlist: ['http://localhost:3000'] }",
  "",
].join("\n");

/**
 * The models the stack's `models` step pulls, from its command: `name:tag` to `sha256:...`.
 *
 * @param compose - The parsed `compose.yaml`.
 */
export function pinnedModels(compose) {
  const command = compose?.services?.models?.command ?? [];
  const out = new Map();
  for (const arg of command.slice(4)) {
    const at = arg.lastIndexOf("@");
    if (at > 0) out.set(arg.slice(0, at), arg.slice(at + 1));
  }
  return out;
}

/**
 * What differs between the pinned models and the ones Ollama holds.
 *
 * @param pinned - From {@link pinnedModels}.
 * @param tags - Ollama's `/api/tags` answer.
 * @returns One line per model that is missing or has another digest.
 */
export function digestProblems(pinned, tags) {
  const held = new Map(
    (tags?.models ?? []).map((m) => [
      m.name,
      String(m.digest).startsWith("sha256:") ? m.digest : `sha256:${m.digest}`,
    ]),
  );
  const out = [];
  for (const [name, digest] of pinned)
    if (!held.has(name)) out.push(`${name} is not in Ollama`);
    else if (held.get(name) !== digest) out.push(`${name} is ${held.get(name)}, the stack pins ${digest}`);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [engine, image] = process.argv.slice(2);
  if (!["docker", "podman"].includes(engine ?? "") || !/@sha256:[0-9a-f]{64}$/.test(image ?? "")) {
    process.stderr.write("usage: node scripts/stack-smoke.mjs <docker|podman> <image@sha256:...>\n");
    process.exit(1);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const work = mkdtempSync(join(tmpdir(), "qajitsu-stack-smoke-"));
  const dir = join(work, "smoke");
  const home = join(work, "home");
  mkdirSync(join(dir, ".qa"), { recursive: true });
  writeFileSync(join(dir, ".qa", "qa.project.yaml"), SMOKE_PROJECT);
  const env = { ...process.env, QAJITSU_HOME: home };
  const run = (cmd, args, cwd = dir) => {
    const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const qj = (...args) => run("node", [join(root, "packages", "cli", "dist", "bin.js"), ...args]);
  const compose = (...args) => run(engine, ["compose", ...args]);
  const problems = [];
  const check = (label, ok, detail = "") => {
    process.stdout.write(
      `${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `\n${detail.trim().split("\n").slice(-12).join("\n")}` : ""}\n`,
    );
    if (!ok) problems.push(label);
  };
  try {
    run("git", ["init", "-q"]);
    const registered = qj("init", "smoke", "--yes", "--qa-dir", ".qa");
    check("project registered", registered.code === 0, registered.out);
    const init = qj(
      "stack",
      "init",
      "--yes",
      "--engine",
      engine,
      "--preset",
      "small",
      "--image",
      image,
      "--ollama-port",
      "21434",
    );
    check("stack init", init.code === 0, init.out);
    const file = readFileSync(join(dir, "compose.yaml"), "utf8");
    const { parse } = await import("yaml");
    const pinned = pinnedModels(parse(file));
    check(
      "models pinned by digest",
      pinned.size === 2 && [...pinned.values()].every((d) => /^sha256:[0-9a-f]{64}$/.test(d)),
    );
    const up = compose("up", "-d", "--wait");
    check("compose up", up.code === 0, up.out);
    // The one-shot step exits 0 only once every model is there at its digest.
    let state = "";
    for (let i = 0; i < 200 && !/exited/.test(state); i++) {
      state = compose("ps", "-a", "--format", "{{.Service}} {{.State}} {{.ExitCode}}").out;
      if (!/models exited/.test(state)) spawnSync("sleep", ["3"]);
    }
    check(
      "models step exited 0",
      /models exited 0/.test(state),
      `${state}\n${compose("logs", "models").out}`,
    );
    const tags = await (await fetch("http://127.0.0.1:21434/api/tags")).json().catch(() => ({}));
    const differ = digestProblems(pinned, tags);
    check("Ollama holds every model at its pinned digest", differ.length === 0, differ.join("\n"));
    const inside = compose("run", "--rm", "qajitsu", "init", "smoke", "--yes", "--qa-dir", ".qa");
    check("QAJitsu registers the project inside the stack", inside.code === 0, inside.out);
    const doctor = compose("run", "--rm", "qajitsu", "doctor");
    check(
      "a run in the stack records its images by digest",
      /qajitsu image\s+\S+@sha256:[0-9a-f]{64} \(declared/.test(doctor.out) &&
        /stack images\s+ollama\/ollama:[\d.]+@sha256:[0-9a-f]{64}/.test(doctor.out),
      doctor.out,
    );
    const again = compose("up", "-d", "--wait");
    spawnSync("sleep", ["5"]);
    const logs = compose("logs", "models").out;
    check("a second start pulls nothing again", again.code === 0 && /already there/.test(logs), logs);
    const [first] = [...pinned.keys()];
    const wrong = compose(
      "run",
      "--rm",
      "models",
      "stack",
      "pull",
      "--ollama",
      "http://ollama:11434",
      `${first}@sha256:${"0".repeat(64)}`,
    );
    check(
      "a model at another digest than the pinned one is refused",
      wrong.code !== 0 && /the stack pins sha256:0{64}/.test(wrong.out),
      wrong.out,
    );
  } finally {
    compose("--profile", "cli", "down", "-v", "--remove-orphans");
    rmSync(work, { recursive: true, force: true });
  }
  if (problems.length > 0) {
    process.stderr.write(`Stack smoke test failed: ${problems.join("; ")}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`Stack smoke test passed on ${engine}.\n`);
}
