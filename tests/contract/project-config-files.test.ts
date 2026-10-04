import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseProjectConfig, TicketKeySchema } from "@qajitsu/core";

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("shipped .qa configuration files (REQ-GEN-01)", () => {
  it.each(["templates/qa/qa.project.yaml", "examples/demo-shop/.qa/qa.project.yaml"])(
    "REQ-GEN-01/AC1: %s is valid against the project schema",
    (path) => {
      const config = parseProjectConfig(parse(read(path)), path);
      expect(config.project).toMatch(/^[a-z]/);
      expect(config.environments.allowlist.length).toBeGreaterThan(0);
    },
  );

  it("REQ-CFG-03: shipped configuration contains secret references, never values", () => {
    for (const path of ["templates/qa/qa.project.yaml", "examples/demo-shop/.qa/qa.project.yaml"]) {
      const config = parseProjectConfig(parse(read(path)), path);
      for (const host of Object.values(config.code_hosts).filter((h) => h.type !== "local")) {
        expect((host.token ?? host.app?.private_key ?? "").startsWith("secret://")).toBe(true);
      }
    }
  });

  it("REQ-NFR-04: demo-shop ticket fixtures use valid keys of the demo project", () => {
    const ticket = JSON.parse(read("examples/demo-shop/tickets/DEMO-1.json")) as { key: string };
    expect(TicketKeySchema.parse(ticket.key)).toBe("DEMO-1");
  });
});

describe("benchmark stays out of PR CI (REQ-LLM-06/AC3)", () => {
  it("REQ-LLM-06/AC3: no CI workflow runs qajitsu bench or pnpm bench", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = new URL("../../.github/workflows/", import.meta.url);
    for (const f of await readdir(dir)) {
      const text = await readFile(new URL(f, dir), "utf8");
      expect(text, f).not.toMatch(/\b(pnpm|qajitsu|qj|bin\.js)\s+bench\b/);
    }
  });
});
