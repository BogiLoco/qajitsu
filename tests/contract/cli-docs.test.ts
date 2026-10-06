// Reference documentation kept in sync with the code (REQ-NFR-03/AC3, REQ-GEN-05/AC3): every CLI command and option
// is documented with its exit codes, every top-level configuration section is in the starter template, every
// adapter package is in the adapters table. A command, option, section or adapter added without docs fails here.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../packages/cli/src/program.js";

type Command = ReturnType<typeof createProgram>;

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (p: string) => readFile(join(root, p), "utf8");

/** Every leaf command as its path (`env up`) with its long option flags. */
const commands = (): { path: string; options: string[] }[] => {
  const program = createProgram("0.0.0", {
    write: () => undefined,
    writeError: () => undefined,
    cwd: root,
    nodeVersion: "v22.22.0",
    setExitCode: () => undefined,
  });
  const out: { path: string; options: string[] }[] = [];
  const walk = (c: Command, path: string[]): void => {
    for (const sub of c.commands) {
      const here = [...path, sub.name()];
      if (sub.commands.length > 0) walk(sub, here);
      // A command with its own arguments is documented too, also when it has subcommands (`explore`).
      if (sub.commands.length === 0 || sub.registeredArguments.length > 0)
        out.push({ path: here.join(" "), options: sub.options.map((o) => o.long ?? "").filter(Boolean) });
    }
  };
  walk(program, []);
  return out;
};

/** Sections `### \`qajitsu <path> ...\`` of docs/cli/commands.md, keyed by command path. */
const referenceSections = async (): Promise<Map<string, string>> => {
  const sections = new Map<string, string>();
  const parts = (await read("docs/cli/commands.md")).split(/^### /m).slice(1);
  for (const part of parts) {
    const heading = /^`qajitsu ([a-z][a-z -]*?)(?: [<[].*)?`/.exec(part);
    if (heading?.[1]) sections.set(heading[1].trim(), part.split(/^## /m)[0] ?? "");
  }
  return sections;
};

describe("reference documentation in sync with the code (REQ-NFR-03/AC3)", () => {
  it("REQ-GEN-05/AC3 + REQ-NFR-03/AC3: every command is documented in docs/cli/commands.md with its options and exit codes", async () => {
    const sections = await referenceSections();
    const cli = commands();
    expect([...sections.keys()].sort()).toEqual(cli.map((c) => c.path).sort());
    for (const { path, options } of cli) {
      const section = sections.get(path) ?? "";
      expect(section, path).toMatch(/^Exit codes: .*`[0-3]`/m);
      const documented = new Set(
        section
          .split("\n")
          .filter((l) => l.startsWith("- `--"))
          .flatMap((l) => l.match(/`--[a-z-]+/g) ?? [])
          .map((f) => f.slice(1)),
      );
      expect([...documented].sort(), path).toEqual([...options].sort());
    }
  });

  it("REQ-NFR-03/AC3: the README command reference names every command", async () => {
    const readme = await read("README.md");
    const reference = readme.slice(readme.indexOf("## 4. Command reference"), readme.indexOf("## 5."));
    for (const { path } of commands()) expect(reference, path).toContain(`\`qj ${path}`);
  });

  it("REQ-NFR-03/AC3: every top-level configuration section appears in the starter template", async () => {
    const schema = JSON.parse(await read("schemas/qa.project.schema.json")) as {
      properties: Record<string, unknown>;
    };
    const template = await read("templates/qa/qa.project.yaml");
    for (const key of Object.keys(schema.properties))
      expect(template, key).toMatch(new RegExp(`^(# ?)?${key}:`, "m"));
  });

  it("REQ-NFR-03/AC3: every adapter package is in the adapters table, and every row is a package", async () => {
    const packages = (await readdir(join(root, "packages", "adapters"), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const rows = (await read("packages/adapters/README.md"))
      .split("\n")
      .map((l) => /^\| `([a-z-]+)`\s*\|.*\|\s*([a-z-]+)\s*\|$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null);
    expect(rows.map((m) => m[1]).sort()).toEqual(packages);
    for (const m of rows) expect(m[2], m[1]).toBe("implemented");
  });

  it("REQ-GEN-05/AC2: the command line offers every command of the catalogue", () => {
    const paths = new Set(commands().map((c) => c.path));
    for (const path of [
      "fetch",
      "init",
      "use",
      "projects list",
      "projects current",
      "plan",
      "approve",
      "run",
      "test",
      "env check",
      "env render",
      "env up",
      "status",
      "note",
      "evidence",
      "logs",
      "runs",
      "resume",
      "clean",
      "gc",
      "work reset",
      "bench",
      "knowledge add",
      "knowledge sync",
      "knowledge search",
      "pull",
    ])
      expect(paths.has(path), path).toBe(true);
  });
});
