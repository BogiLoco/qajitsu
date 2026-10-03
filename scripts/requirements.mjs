#!/usr/bin/env node
// Requirements catalogue tooling (REQ-NFR-03, REQ-NFR-08).
//
//   node scripts/requirements.mjs check   validate docs/requirements/*.md, exit 1 on problems
//   node scripts/requirements.mjs index   regenerate the index table in docs/requirements/README.md
//   node scripts/requirements.mjs list [--stage N] [--status S]   print matching requirements
//
// Format rules are documented in docs/requirements/README.md.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const STATUSES = ["proposed", "accepted", "in-progress", "implemented", "deferred", "deprecated"];
export const PRIORITIES = ["must", "should", "could"];
export const STAGES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "later"];

const INDEX_START = "<!-- req-index:start -->";
const INDEX_END = "<!-- req-index:end -->";
const REQ_HEADING = /^### (REQ-([A-Z]+)-(\d{2,3})) · (.+)$/;
const AREA_HEADING = /^# (.+) \(([A-Z]+)\)\s*$/;
const META_LINE = /^- (Status|Priority|Stage|Related):\s*(.*)$/;
const AC_LINE = /^- \[( |x)\] AC(\d+): (.+)$/;
const REF = /^(REQ-[A-Z]+-\d{2,3}|INV-\d+|ADR-\d{4})$/;

/** GitHub-compatible heading anchor. */
export function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * Parses one area file.
 * @returns {{ area: {prefix: string|undefined, title: string|undefined, file: string}, requirements: object[], problems: string[] }}
 */
export function parseAreaFile(content, file) {
  const lines = content.split(/\r?\n/);
  const problems = [];
  const requirements = [];
  let area = { prefix: undefined, title: undefined, file };
  let current;
  let inFence = false;

  const finish = () => {
    if (current) requirements.push(current);
    current = undefined;
  };

  lines.forEach((line, i) => {
    const where = `${file}:${String(i + 1)}`;
    if (line.startsWith("```")) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const areaMatch = AREA_HEADING.exec(line);
    if (areaMatch && area.prefix === undefined) {
      area = { prefix: areaMatch[2], title: areaMatch[1], file };
      return;
    }
    if (line.startsWith("### ")) {
      finish();
      const m = REQ_HEADING.exec(line);
      if (!m) {
        problems.push(`${where}: heading is not "### REQ-<AREA>-NN · Title": ${line}`);
        return;
      }
      current = {
        id: m[1],
        prefix: m[2],
        title: m[4].trim(),
        anchor: slugify(line.slice(4)),
        file,
        line: i + 1,
        meta: {},
        criteria: [],
      };
      return;
    }
    if (line.startsWith("## ") || line.startsWith("# ")) {
      finish();
      return;
    }
    if (!current) return;

    const meta = META_LINE.exec(line);
    if (meta) {
      const key = meta[1].toLowerCase();
      if (key in current.meta) problems.push(`${where}: ${current.id} has "${meta[1]}" twice`);
      current.meta[key] = meta[2].trim();
      return;
    }
    const ac = AC_LINE.exec(line);
    if (ac) {
      current.criteria.push({ n: Number(ac[2]), done: ac[1] === "x", text: ac[3] });
      return;
    }
    if (/^- \[[^ x]?\]/.test(line) || /^- \[( |x)\] (?!AC\d+: )/.test(line)) {
      problems.push(`${where}: checkbox must look like "- [ ] ACn: text": ${line}`);
    }
  });
  finish();

  if (area.prefix === undefined) problems.push(`${file}: missing H1 "# Area title (PREFIX)"`);
  return { area, requirements, problems };
}

/** Splits a Related value into references; "-" or empty means none. */
export function parseRelated(value) {
  if (value === undefined || value === "" || value === "-") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validates a parsed catalogue.
 * @param {ReturnType<typeof parseAreaFile>[]} areas
 * @param {{ invariantCount: number, adrIds: Set<string> }} context
 * @returns {string[]} problems
 */
export function validateCatalogue(areas, context) {
  const problems = areas.flatMap((a) => a.problems);
  const all = areas.flatMap((a) => a.requirements);
  const ids = new Map();
  const prefixes = new Map();

  for (const a of areas) {
    if (a.area.prefix === undefined) continue;
    const other = prefixes.get(a.area.prefix);
    if (other) problems.push(`${a.area.file}: prefix ${a.area.prefix} already used by ${other}`);
    prefixes.set(a.area.prefix, a.area.file);
  }

  for (const r of all) {
    const at = `${r.file}:${String(r.line)} ${r.id}`;
    const seen = ids.get(r.id);
    if (seen) problems.push(`${at}: duplicate id (first at ${seen})`);
    else ids.set(r.id, `${r.file}:${String(r.line)}`);
  }

  for (const a of areas) {
    for (const r of a.requirements) {
      const at = `${r.file}:${String(r.line)} ${r.id}`;
      if (a.area.prefix !== undefined && r.prefix !== a.area.prefix) {
        problems.push(`${at}: prefix ${r.prefix} does not match file prefix ${a.area.prefix}`);
      }
      const { status, priority, stage, related } = r.meta;
      if (status === undefined) problems.push(`${at}: missing "- Status:"`);
      else if (!STATUSES.includes(status))
        problems.push(`${at}: invalid status "${status}" (${STATUSES.join("|")})`);
      if (priority === undefined) problems.push(`${at}: missing "- Priority:"`);
      else if (!PRIORITIES.includes(priority))
        problems.push(`${at}: invalid priority "${priority}" (${PRIORITIES.join("|")})`);
      if (stage === undefined) problems.push(`${at}: missing "- Stage:"`);
      else if (!STAGES.includes(stage))
        problems.push(`${at}: invalid stage "${stage}" (${STAGES.join("|")})`);
      if (related === undefined) problems.push(`${at}: missing "- Related:" (use "-" for none)`);

      for (const ref of parseRelated(related)) {
        if (!REF.test(ref)) {
          problems.push(`${at}: malformed reference "${ref}" (REQ-AREA-NN, INV-n, ADR-nnnn)`);
        } else if (ref.startsWith("REQ-")) {
          if (!ids.has(ref)) problems.push(`${at}: references unknown requirement ${ref}`);
          if (ref === r.id) problems.push(`${at}: references itself`);
        } else if (ref.startsWith("INV-")) {
          const n = Number(ref.slice(4));
          if (n < 1 || n > context.invariantCount)
            problems.push(`${at}: references unknown invariant ${ref}`);
        } else if (!context.adrIds.has(ref)) {
          problems.push(`${at}: references unknown decision record ${ref}`);
        }
      }

      if (r.criteria.length === 0) problems.push(`${at}: needs at least one acceptance criterion`);
      r.criteria.forEach((c, i) => {
        if (c.n !== i + 1)
          problems.push(
            `${at}: acceptance criteria must be numbered AC1..ACn in order (found AC${String(c.n)})`,
          );
      });
      if (status === "implemented" && r.criteria.some((c) => !c.done)) {
        problems.push(`${at}: status is implemented but not every acceptance criterion is ticked`);
      }
    }
  }
  return problems;
}

/** Renders the index table for README.md. */
export function renderIndex(areas) {
  const all = areas.flatMap((a) => a.requirements);
  const byStatus = STATUSES.map((s) => [s, all.filter((r) => r.meta.status === s).length]).filter(
    ([, n]) => n > 0,
  );
  const done = all.reduce((n, r) => n + r.criteria.filter((c) => c.done).length, 0);
  const total = all.reduce((n, r) => n + r.criteria.length, 0);

  const out = [
    `${String(all.length)} requirements (${byStatus.map(([s, n]) => `${String(n)} ${s}`).join(", ")}); ` +
      `${String(done)}/${String(total)} acceptance criteria done.`,
    "",
    "| Id | Title | Status | Priority | Stage | AC done |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of all) {
    const ac = `${String(r.criteria.filter((c) => c.done).length)}/${String(r.criteria.length)}`;
    const title = r.title.replace(/\|/g, "\\|");
    out.push(
      `| [${r.id}](${r.file}#${r.anchor}) | ${title} | ${r.meta.status ?? "?"} | ${r.meta.priority ?? "?"} | ${r.meta.stage ?? "?"} | ${ac} |`,
    );
  }
  return out.join("\n");
}

/** Replaces the content between the index markers. Throws if markers are missing. */
export function replaceIndex(readme, table) {
  const start = readme.indexOf(INDEX_START);
  const end = readme.indexOf(INDEX_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md must contain ${INDEX_START} and ${INDEX_END}`);
  }
  return `${readme.slice(0, start + INDEX_START.length)}\n${table}\n${readme.slice(end)}`;
}

const STAGE_BLOCK = /(<!-- req-stage:(\w+) -->)\n[\s\S]*?(<!-- \/req-stage -->)/g;

/**
 * Fills every `<!-- req-stage:N -->...<!-- /req-stage -->` block (used in docs/roadmap.md)
 * with the requirements of that stage.
 */
export function replaceStageLists(text, areas, linkPrefix = "requirements/") {
  const all = areas.flatMap((a) => a.requirements);
  return text.replace(STAGE_BLOCK, (_m, open, stage, close) => {
    const items = all
      .filter((r) => r.meta.stage === stage && r.meta.status !== "deprecated")
      .map((r) => {
        const ac = `${String(r.criteria.filter((c) => c.done).length)}/${String(r.criteria.length)}`;
        return `- [${r.id}](${linkPrefix}${r.file}#${r.anchor}) ${r.title} (${r.meta.priority ?? "?"}, ${r.meta.status ?? "?"}, AC ${ac})`;
      });
    return `${open}\n${items.length > 0 ? items.join("\n") : "- (none)"}\n${close}`;
  });
}

/** Loads everything the checker needs from a repository root. */
export function loadCatalogue(root) {
  const dir = join(root, "docs", "requirements");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md" && !f.startsWith("_"))
    .sort();
  const areas = files.map((f) => parseAreaFile(readFileSync(join(dir, f), "utf8"), f));

  const invPath = join(root, ".claude", "rules", "architecture-invariants.md");
  const invariantCount = existsSync(invPath)
    ? readFileSync(invPath, "utf8")
        .split(/\r?\n/)
        .filter((l) => /^\d+\. /.test(l)).length
    : 0;

  const adrDir = join(root, "docs", "adr");
  const adrIds = new Set(
    existsSync(adrDir)
      ? readdirSync(adrDir)
          .map((f) => /^(\d{4})-.+\.md$/.exec(f)?.[1])
          .filter(Boolean)
          .map((n) => `ADR-${n}`)
      : [],
  );

  // Keep area order stable and readable: follow the table order in README when present.
  const readmePath = join(dir, "README.md");
  const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
  const order = [...readme.matchAll(/\]\(([a-z0-9-]+\.md)\)/g)].map((m) => m[1]);
  areas.sort((a, b) => rank(order, a.area.file) - rank(order, b.area.file));

  const roadmapPath = join(root, "docs", "roadmap.md");
  const roadmap = existsSync(roadmapPath) ? readFileSync(roadmapPath, "utf8") : undefined;

  return { areas, invariantCount, adrIds, readmePath, readme, roadmapPath, roadmap };
}

function rank(order, file) {
  const i = order.indexOf(file);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const [command = "check", ...rest] = argv;
  const cat = loadCatalogue(root);

  if (command === "index") {
    writeFileSync(cat.readmePath, replaceIndex(cat.readme, renderIndex(cat.areas)));
    process.stdout.write("Updated docs/requirements/README.md\n");
    if (cat.roadmap !== undefined) {
      writeFileSync(cat.roadmapPath, replaceStageLists(cat.roadmap, cat.areas));
      process.stdout.write("Updated docs/roadmap.md\n");
    }
    return 0;
  }

  if (command === "check") {
    const problems = validateCatalogue(cat.areas, cat);
    try {
      const expected = replaceIndex(cat.readme, renderIndex(cat.areas));
      if (expected !== cat.readme)
        problems.push("docs/requirements/README.md: index is stale, run `pnpm req:index`");
    } catch (e) {
      problems.push(`docs/requirements/README.md: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (cat.roadmap !== undefined && replaceStageLists(cat.roadmap, cat.areas) !== cat.roadmap) {
      problems.push("docs/roadmap.md: stage lists are stale, run `pnpm req:index`");
    }
    const count = cat.areas.reduce((n, a) => n + a.requirements.length, 0);
    if (problems.length > 0) {
      process.stderr.write(`Requirements check failed (${String(problems.length)} problems):\n`);
      for (const p of problems) process.stderr.write(`  - ${p}\n`);
      return 1;
    }
    process.stdout.write(
      `Requirements OK: ${String(count)} requirements in ${String(cat.areas.length)} areas.\n`,
    );
    return 0;
  }

  if (command === "list") {
    const flag = (name) => {
      const i = rest.indexOf(`--${name}`);
      return i === -1 ? undefined : rest[i + 1];
    };
    const stage = flag("stage");
    const status = flag("status");
    for (const r of cat.areas.flatMap((a) => a.requirements)) {
      if (stage !== undefined && r.meta.stage !== stage) continue;
      if (status !== undefined && r.meta.status !== status) continue;
      const ac = `${String(r.criteria.filter((c) => c.done).length)}/${String(r.criteria.length)}`;
      process.stdout.write(
        `${r.id}\t${r.meta.status ?? "?"}\tstage ${r.meta.stage ?? "?"}\t${ac}\t${r.title}\n`,
      );
    }
    return 0;
  }

  process.stderr.write(`Unknown command "${command}". Use: check | index | list [--stage N] [--status S]\n`);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
