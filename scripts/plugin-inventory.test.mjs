import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkInventory,
  loadInventory,
  parseInventory,
  renderInventoryIndex,
  validateInventory,
} from "./plugin-inventory.mjs";

const entry = (name, overrides = {}) => {
  const fields = {
    Type: "ticket source",
    Interface: "TicketSource",
    Status: "exists",
    Package: "packages/adapters/ticket-acme",
    Requirements: "REQ-SMP-01",
    Dependencies: "none",
    Hosts: "acme.example.com",
    Secrets: "API token",
    Tier: "official open source",
    Placement: "plugin",
    Names: "Acme",
    ...overrides,
  };
  return [
    `### ${name}`,
    "",
    ...Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `- ${k}: ${v}`),
    "",
  ].join("\n");
};

const doc = (...entries) =>
  `# Plugin inventory\n\n<!-- plugin-index:start -->\n<!-- plugin-index:end -->\n\n## Ticket sources\n\n${entries.join("\n")}`;

const context = {
  adapterPackages: ["packages/adapters/ticket-acme"],
  paths: new Set(["packages/adapters/ticket-acme", "packages/models"]),
  interfaces: new Set(["TicketSource", "Publisher"]),
  requirements: [
    { id: "REQ-SMP-01", status: "accepted", text: "Tickets come from Acme." },
    { id: "REQ-SMP-02", status: "proposed", text: "Nothing named here." },
  ],
  watchedNames: ["Acme", "Globex"],
};

const problemsOf = (content, ctx = context) => validateInventory(parseInventory(content), ctx);

describe("plugin inventory check (REQ-GEN-14/AC5)", () => {
  it("REQ-GEN-14/AC1: parses one entry per heading with its fields", () => {
    const inv = parseInventory(doc(entry("Acme tickets")));
    expect(inv.problems).toEqual([]);
    expect(inv.entries).toHaveLength(1);
    expect(inv.entries[0]).toMatchObject({
      name: "Acme tickets",
      section: "Ticket sources",
      fields: { type: "ticket source", interface: "TicketSource", status: "exists", names: "Acme" },
    });
  });

  it("REQ-GEN-14/AC1: accepts a complete inventory", () => {
    expect(problemsOf(doc(entry("Acme tickets")))).toEqual([]);
  });

  it("REQ-GEN-14/AC1: Notes is optional, other fields are refused", () => {
    expect(problemsOf(doc(entry("Acme tickets", { Notes: "Read only." })))).toEqual([]);
    expect(
      problemsOf(doc(entry("Acme tickets", { Colour: "blue" }))).some((p) =>
        p.includes('unknown field "Colour"'),
      ),
    ).toBe(true);
  });

  it("REQ-GEN-14/AC1: every entry needs every field", () => {
    const problems = problemsOf(doc(entry("Acme tickets", { Hosts: undefined, Tier: undefined })));
    expect(problems.some((p) => p.includes('Acme tickets: missing "- Hosts:"'))).toBe(true);
    expect(problems.some((p) => p.includes('Acme tickets: missing "- Tier:"'))).toBe(true);
  });

  it("REQ-GEN-14/AC1: rejects unknown types, statuses, tiers and placements", () => {
    const problems = problemsOf(
      doc(
        entry("Acme tickets", {
          Type: "ticket source, teleporter",
          Status: "maybe",
          Tier: "gold",
          Placement: "somewhere",
        }),
      ),
    );
    expect(problems.some((p) => p.includes('unknown plugin type "teleporter"'))).toBe(true);
    expect(problems.some((p) => p.includes('invalid status "maybe"'))).toBe(true);
    expect(problems.some((p) => p.includes('invalid tier "gold"'))).toBe(true);
    expect(problems.some((p) => p.includes('invalid placement "somewhere"'))).toBe(true);
  });

  it("REQ-GEN-14/AC1: requirements must exist and there must be at least one", () => {
    expect(
      problemsOf(doc(entry("Acme tickets", { Requirements: "REQ-SMP-09" }))).some((p) =>
        p.includes("unknown requirement REQ-SMP-09"),
      ),
    ).toBe(true);
    expect(
      problemsOf(doc(entry("Acme tickets", { Requirements: "-" }))).some((p) =>
        p.includes("names no requirement"),
      ),
    ).toBe(true);
  });

  it("REQ-GEN-14/AC3: an interface is one of @qajitsu/core or a named gap", () => {
    expect(problemsOf(doc(entry("Acme tickets", { Interface: "TicketSource, Publisher" })))).toEqual([]);
    expect(
      problemsOf(doc(entry("Acme tickets", { Interface: "new ChainAdapter (ADR before implementation)" }))),
    ).toEqual([]);
    expect(
      problemsOf(doc(entry("Acme tickets", { Interface: "TicketSauce" }))).some((p) =>
        p.includes('"TicketSauce" is not an interface of @qajitsu/core'),
      ),
    ).toBe(true);
  });

  it("REQ-GEN-14/AC1: an existing plugin names a package that exists", () => {
    const missing = problemsOf(doc(entry("Acme tickets", { Package: "packages/adapters/ticket-gone" })));
    expect(missing.some((p) => p.includes("package packages/adapters/ticket-gone does not exist"))).toBe(
      true,
    );
    const none = problemsOf(doc(entry("Acme tickets", { Package: "-" })), {
      ...context,
      adapterPackages: [],
    });
    expect(none.some((p) => p.includes("status exists but names no package"))).toBe(true);
    expect(
      problemsOf(doc(entry("Acme tickets", { Status: "planned", Package: "-" })), {
        ...context,
        adapterPackages: [],
      }),
    ).toEqual([]);
  });

  it("REQ-GEN-14/AC5: an integration package missing from the inventory fails", () => {
    const problems = problemsOf(doc(entry("Acme tickets")), {
      ...context,
      adapterPackages: ["packages/adapters/ticket-acme", "packages/adapters/secrets-new"],
      paths: new Set([...context.paths, "packages/adapters/secrets-new"]),
    });
    expect(problems).toContain(
      "docs/architecture/plugins.md: integration package packages/adapters/secrets-new is missing from the inventory",
    );
  });

  it("REQ-GEN-14/AC5: a requirement naming an integration missing from the inventory fails", () => {
    const problems = problemsOf(doc(entry("Acme tickets")), {
      ...context,
      requirements: [
        ...context.requirements,
        { id: "REQ-SMP-03", status: "proposed", text: "Results go to Globex." },
        { id: "REQ-SMP-04", status: "deprecated", text: "Old Globex idea." },
      ],
    });
    expect(problems).toEqual([
      'docs/architecture/plugins.md: REQ-SMP-03 names the integration "Globex", which is missing from the inventory (add it to the Names of an entry)',
    ]);
  });

  it("REQ-GEN-14/AC5: names match whole words with their case only", () => {
    const ctx = {
      ...context,
      requirements: [
        { id: "REQ-SMP-01", status: "accepted", text: "Tickets come from Acme." },
        { id: "REQ-SMP-03", status: "proposed", text: "globex, Globexes and pre-Globex are not names." },
      ],
    };
    expect(problemsOf(doc(entry("Acme tickets")), ctx)).toEqual([]);
  });

  it("REQ-GEN-14/AC5: a name belongs to one entry and entries are unique", () => {
    const problems = problemsOf(
      doc(entry("Acme tickets"), entry("Acme tickets"), entry("Acme bugs", { Names: "Acme" })),
    );
    expect(problems.some((p) => p.includes('duplicate entry "Acme tickets"'))).toBe(true);
    expect(problems.some((p) => p.includes('name "Acme" is listed by'))).toBe(true);
  });

  it("REQ-GEN-14/AC5: the summary table is generated and checked", () => {
    const content = doc(entry("Acme tickets"));
    const table = renderInventoryIndex(parseInventory(content));
    expect(table).toContain(
      "| [Acme tickets](#acme-tickets) | ticket source | TicketSource | exists | plugin | official open source |",
    );
    expect(checkInventory({ ...context, content, path: "docs/architecture/plugins.md" })).toContain(
      "docs/architecture/plugins.md: summary table is stale, run `pnpm req:index`",
    );
  });

  it("REQ-GEN-14/AC5: a missing inventory fails", () => {
    expect(checkInventory({ ...context, content: undefined, path: "docs/architecture/plugins.md" })).toEqual([
      "docs/architecture/plugins.md: missing; every integration package must be listed (REQ-GEN-14)",
    ]);
  });

  it("REQ-GEN-14/AC5: the repository inventory is complete", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    expect(checkInventory(loadInventory(root))).toEqual([]);
  });
});
