import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";
import { annotatedFirst } from "./annotated.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const find = async (dir: string, suffix: string): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile() && e.name.endsWith(suffix)) out.push(join(e.parentPath, e.name));
  return out.sort();
};
const red = (png: Buffer, x: number, y: number): boolean => {
  const img = PNG.sync.read(png);
  const i = (Math.round(y) * img.width + Math.round(x)) * 4;
  return img.data[i] === 225 && img.data[i + 1] === 29 && img.data[i + 2] === 72;
};

describe("annotated failure screenshots in a real browser (REQ-EVD-08)", () => {
  it("REQ-EVD-08/AC1+AC4+AC5: the disabled checkout button is boxed in red on a copy; reports show it first", async () => {
    const p = await createDemoPipeline({ ticket: "DEMO-4", flag: "BUG_CHECKOUT_BUTTON_DISABLED" });
    cleanups.push(p.cleanup);
    const run = await p.executed();
    expect(run.exitCode).toBe(1);
    const [annotations] = await find(join(p.runDir, "evidence"), "-annotations.json");
    expect(annotations).toBeDefined();
    const { marks } = JSON.parse(await readFile(annotations ?? "", "utf8")) as {
      marks: {
        n: number;
        field: string;
        expected: unknown;
        actual: unknown;
        box?: { x: number; y: number; width: number; height: number };
      }[];
    };
    const mark = marks.find((m) => m.box !== undefined);
    expect(mark).toMatchObject({ n: 1, expected: true, actual: false });
    expect(mark?.field).toMatch(/^elements\..+\.enabled$/);
    const box = mark?.box ?? { x: 0, y: 0, width: 0, height: 0 };
    const annotatedFile = annotations?.replace(/-annotations\.json$/, "-annotated.png") ?? "";
    const originalFile = annotations?.replace(/-annotations\.json$/, ".png") ?? "";
    const annotated = await readFile(annotatedFile);
    const original = await readFile(originalFile);
    // A red frame just outside the button's left edge, the button itself untouched, the original unchanged.
    expect(red(annotated, box.x - 2, box.y + box.height / 2)).toBe(true);
    expect(red(annotated, box.x + box.width / 2, box.y + box.height / 2)).toBe(false);
    expect(red(original, box.x - 2, box.y + box.height / 2)).toBe(false);
    // Both are evidence with their hashes.
    const manifest = JSON.parse(await readFile(join(p.runDir, "evidence", "manifest.json"), "utf8")) as {
      path: string;
    }[];
    const rel = (f: string) => f.slice(join(p.runDir, "evidence").length + 1);
    expect(manifest.map((m) => m.path)).toEqual(
      expect.arrayContaining([rel(annotatedFile), rel(originalFile), rel(annotations ?? "")]),
    );
    // AC5: first in the report and in `qj evidence --failed`, with what the box marks.
    const html = await readFile(join(p.runDir, "report", "report.html"), "utf8");
    expect(html.indexOf(rel(annotatedFile))).toBeGreaterThan(-1);
    expect(html.indexOf(rel(annotatedFile))).toBeLessThan(html.indexOf(rel(originalFile)));
    const shown = await p.run(["evidence", "DEMO-4", "--failed", "--no-open"]);
    expect(shown.out).toMatch(/\[1\] S\d+ elements\..+\.enabled \(expected true, actual false\)/);
    expect(shown.out.indexOf("-annotated.png")).toBeLessThan(
      shown.out.indexOf(`${rel(originalFile).split("/").at(-1) ?? ""} (sha256`),
    );
    // The ticket comment attaches it first after the evidence zip; the bug lists it as its first evidence.
    expect((await p.run(["publish", "DEMO-4", "--auto-publish"])).exitCode).toBe(0);
    const record = JSON.parse(await readFile(join(p.runDir, "run.json"), "utf8")) as {
      data: { publish: { attachmentNames: string[] } };
    };
    expect(record.data.publish.attachmentNames[1]).toMatch(/-annotated\.png$/);
    expect((await p.run(["bug", "DEMO-4", "--yes"])).exitCode).toBe(0);
    const [bugFile] = await find(join(p.runDir, "report", "bugs"), ".json");
    const bugText = (JSON.parse(await readFile(bugFile ?? "", "utf8")) as { description: { text: string } })
      .description.text;
    const evidenceLines = bugText.split("\n").filter((l) => /sha256 [0-9a-f]+/.test(l));
    expect(evidenceLines[0]).toContain("-annotated.png");
  }, 240_000);
});

describe("annotated first (REQ-EVD-08/AC5)", () => {
  it("REQ-EVD-08/AC5: annotated screenshots, then the annotated baseline, then the rest in order", () => {
    expect(
      annotatedFirst(
        ["S1.png", "S2-annotated-baseline.png", "S1-01.json", "S2-annotated.png", "video.webm"],
        (p) => p,
      ),
    ).toEqual(["S2-annotated.png", "S2-annotated-baseline.png", "S1.png", "S1-01.json", "video.webm"]);
  });
});
