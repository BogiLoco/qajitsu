// The Claude Code plugin (REQ-GEN-04): manifest, marketplace entry and the three skills; every `qajitsu`
// command a skill tells Claude to run exists in the CLI.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createProgram } from "../../packages/cli/src/program.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (p: string) => readFile(join(root, p), "utf8");

describe("Claude Code plugin (REQ-GEN-04)", () => {
  it("REQ-GEN-04/AC1: manifest, marketplace and skills /qa-plan, /qa-run, /qa-evidence", async () => {
    const manifest = JSON.parse(await read("plugin/.claude-plugin/plugin.json")) as { name: string };
    expect(manifest.name).toBe("qajitsu");
    const market = JSON.parse(await read(".claude-plugin/marketplace.json")) as {
      plugins: { name: string; source: string }[];
    };
    expect(market.plugins).toEqual([expect.objectContaining({ name: "qajitsu", source: "./plugin" })]);
    const commands = createProgram("0", {
      write: () => undefined,
      writeError: () => undefined,
      cwd: root,
      nodeVersion: "v22.22.0",
      setExitCode: () => undefined,
    }).commands.map((c) => c.name());
    for (const skill of ["qa-plan", "qa-run", "qa-evidence"]) {
      const text = await read(`plugin/skills/${skill}/SKILL.md`);
      const front = parse(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "") as {
        name: string;
        description: string;
      };
      expect(front.name).toBe(skill);
      expect(front.description.length).toBeGreaterThan(40);
      for (const m of text.matchAll(/`qajitsu ([a-z]+)/g))
        expect(commands, `${skill}: qajitsu ${m[1] ?? ""}`).toContain(m[1]);
    }
    // The approval stays with the user.
    expect(await read("plugin/skills/qa-plan/SKILL.md")).toContain("Never approve on your own");
  });
});
