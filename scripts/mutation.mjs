#!/usr/bin/env node
// Mutation testing of the trust-critical packages (REQ-NFR-14): checks that every StrykerJS exclusion states why,
// then runs StrykerJS for each package (all three, or the ones named). Usage: pnpm mutation [guard|verifier|steps...]
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The packages whose sources are mutated. */
export const MUTATED = ["guard", "verifier", "steps"];

/**
 * Exclusions without a reason (REQ-NFR-14/AC4). A StrykerJS comment `// Stryker disable [next-line] <mutators>` must
 * end with `: <why>` of at least ten characters, saying why the mutant cannot change behaviour.
 *
 * @param file - The file's path, for the message.
 * @param text - The file's text.
 * @returns One line per comment without a reason.
 */
export function unexplainedExclusions(file, text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    const m = /Stryker\s+(disable|restore)\b(.*)$/.exec(line);
    if (!m || m[1] === "restore") return;
    const reason = /:\s*(.+?)\s*(\*\/)?\s*$/.exec(m[2] ?? "")?.[1] ?? "";
    if (reason.length < 10)
      out.push(
        `${file}:${String(i + 1)}: a Stryker exclusion needs ": <why the mutant cannot change behaviour>"`,
      );
  });
  return out;
}

const sources = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")
        ? [join(dir, e.name)]
        : [],
  );

const main = () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const chosen = process.argv.slice(2);
  const packages = chosen.length > 0 ? chosen : MUTATED;
  const unknown = packages.filter((p) => !MUTATED.includes(p));
  if (unknown.length > 0) {
    process.stderr.write(`Unknown package(s): ${unknown.join(", ")}; mutated are ${MUTATED.join(", ")}.\n`);
    process.exit(3);
  }
  const problems = MUTATED.flatMap((p) =>
    sources(join(root, "packages", p, "src")).flatMap((f) =>
      unexplainedExclusions(relative(root, f), readFileSync(f, "utf8")),
    ),
  );
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
  for (const p of packages) {
    process.stdout.write(`\n== Mutation testing of packages/${p} ==\n`);
    const run = spawnSync(
      join(root, "node_modules", ".bin", "stryker"),
      ["run", `stryker/${p}.config.json`],
      {
        cwd: root,
        stdio: "inherit",
      },
    );
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
