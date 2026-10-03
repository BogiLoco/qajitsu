import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCatalogue,
  parseAreaFile,
  parseRelated,
  renderIndex,
  replaceIndex,
  replaceStageLists,
  slugify,
  validateCatalogue,
} from "./requirements.mjs";

const ctx = { invariantCount: 12, adrIds: new Set(["ADR-0001"]) };

const good = `# Sample area (SMP)

Intro text.

### REQ-SMP-01 · First thing

- Status: accepted
- Priority: must
- Stage: 1
- Related: INV-2, ADR-0001, REQ-SMP-02

Description.

**Acceptance criteria**

- [x] AC1: Does one thing.
- [ ] AC2: Does another.

### REQ-SMP-02 · Second \`thing\`

- Status: implemented
- Priority: could
- Stage: later
- Related: -

**Acceptance criteria**

- [x] AC1: Done.

\`\`\`markdown
### REQ-XXX-99 · Example inside a fence is ignored
\`\`\`
`;

const check = (content, file = "sample.md") => validateCatalogue([parseAreaFile(content, file)], ctx);

describe("requirements catalogue tooling (REQ-NFR-03, REQ-NFR-08)", () => {
  it("parses area, metadata and acceptance criteria", () => {
    const { area, requirements, problems } = parseAreaFile(good, "sample.md");
    expect(problems).toEqual([]);
    expect(area.prefix).toBe("SMP");
    expect(requirements.map((r) => r.id)).toEqual(["REQ-SMP-01", "REQ-SMP-02"]);
    expect(requirements[0].meta).toEqual({
      status: "accepted",
      priority: "must",
      stage: "1",
      related: "INV-2, ADR-0001, REQ-SMP-02",
    });
    expect(requirements[0].criteria).toEqual([
      { n: 1, done: true, text: "Does one thing." },
      { n: 2, done: false, text: "Does another." },
    ]);
  });

  it("accepts a valid catalogue", () => {
    expect(check(good)).toEqual([]);
  });

  it("builds GitHub-compatible anchors", () => {
    expect(slugify("REQ-SMP-02 · Second `thing`")).toBe("req-smp-02--second-thing");
    expect(slugify("REQ-WS-02 · Unique run id")).toBe("req-ws-02--unique-run-id");
  });

  it("treats '-' and empty Related as no references", () => {
    expect(parseRelated("-")).toEqual([]);
    expect(parseRelated("")).toEqual([]);
    expect(parseRelated("INV-1, REQ-A-01")).toEqual(["INV-1", "REQ-A-01"]);
  });

  it("rejects duplicate ids", () => {
    const dup = good.replace("REQ-SMP-02 · Second", "REQ-SMP-01 · Second");
    expect(check(dup).some((p) => p.includes("duplicate id"))).toBe(true);
  });

  it("rejects a prefix that does not match the file", () => {
    const wrong = good.replace("REQ-SMP-02 · Second", "REQ-OTH-02 · Second");
    expect(check(wrong).some((p) => p.includes("does not match file prefix"))).toBe(true);
  });

  it("rejects invalid status, priority and stage", () => {
    const bad = good
      .replace("Status: accepted", "Status: done")
      .replace("Priority: must", "Priority: high")
      .replace("Stage: 1\n", "Stage: 11\n");
    const problems = check(bad);
    expect(problems.some((p) => p.includes('invalid status "done"'))).toBe(true);
    expect(problems.some((p) => p.includes('invalid priority "high"'))).toBe(true);
    expect(problems.some((p) => p.includes('invalid stage "11"'))).toBe(true);
  });

  it("rejects unknown and malformed references", () => {
    const bad = good.replace("INV-2, ADR-0001, REQ-SMP-02", "INV-13, ADR-0009, REQ-SMP-07, R4");
    const problems = check(bad);
    expect(problems.some((p) => p.includes("unknown invariant INV-13"))).toBe(true);
    expect(problems.some((p) => p.includes("unknown decision record ADR-0009"))).toBe(true);
    expect(problems.some((p) => p.includes("unknown requirement REQ-SMP-07"))).toBe(true);
    expect(problems.some((p) => p.includes('malformed reference "R4"'))).toBe(true);
  });

  it("rejects implemented requirements with open criteria", () => {
    const bad = good.replace("- [x] AC1: Done.", "- [ ] AC1: Done.");
    expect(check(bad).some((p) => p.includes("not every acceptance criterion is ticked"))).toBe(true);
  });

  it("rejects missing metadata, missing criteria and bad numbering", () => {
    const bad = good
      .replace("- Priority: could\n", "")
      .replace("- [x] AC2", "- [x] AC3")
      .replace("- [ ] AC2: Does another.", "- [ ] AC3: Does another.")
      .replace("- [x] AC1: Done.", "");
    const problems = check(bad);
    expect(problems.some((p) => p.includes('missing "- Priority:"'))).toBe(true);
    expect(problems.some((p) => p.includes("numbered AC1..ACn"))).toBe(true);
    expect(problems.some((p) => p.includes("at least one acceptance criterion"))).toBe(true);
  });

  it("reports malformed headings and checkboxes", () => {
    const bad = `${good}\n### Not a requirement\n`;
    expect(check(bad).some((p) => p.includes("heading is not"))).toBe(true);
    const box = good.replace("- [ ] AC2: Does another.", "- [ ] Does another.");
    expect(check(box).some((p) => p.includes("checkbox must look like"))).toBe(true);
  });

  it("renders and replaces the index between markers", () => {
    const table = renderIndex([parseAreaFile(good, "sample.md")]);
    expect(table).toContain("2 requirements (1 accepted, 1 implemented); 2/3 acceptance criteria done.");
    expect(table).toContain(
      "| [REQ-SMP-01](sample.md#req-smp-01--first-thing) | First thing | accepted | must | 1 | 1/2 |",
    );
    const readme = "a\n<!-- req-index:start -->\nold\n<!-- req-index:end -->\nb";
    expect(replaceIndex(readme, "NEW")).toBe("a\n<!-- req-index:start -->\nNEW\n<!-- req-index:end -->\nb");
    expect(() => replaceIndex("no markers", "x")).toThrow(/req-index/);
  });

  it("fills roadmap stage blocks", () => {
    const areas = [parseAreaFile(good, "sample.md")];
    const text =
      "x\n<!-- req-stage:1 -->\nold\n<!-- /req-stage -->\n<!-- req-stage:9 -->\n<!-- /req-stage -->\n";
    expect(replaceStageLists(text, areas)).toBe(
      "x\n<!-- req-stage:1 -->\n- [REQ-SMP-01](requirements/sample.md#req-smp-01--first-thing) First thing (must, accepted, AC 1/2)\n<!-- /req-stage -->\n<!-- req-stage:9 -->\n- (none)\n<!-- /req-stage -->\n",
    );
  });

  it("the repository catalogue is valid", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const cat = loadCatalogue(root);
    expect(validateCatalogue(cat.areas, cat)).toEqual([]);
    expect(cat.invariantCount).toBe(12);
  });
});
