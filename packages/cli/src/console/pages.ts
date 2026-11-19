import type { ConsoleProject, ConsoleRun, ConsoleRunEntry } from "./data.js";

/** Text for HTML: every character that could open markup is escaped. */
export const esc = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
/** A path segment for a link. */
const seg = (s: string): string => encodeURIComponent(s);

const STYLE = `
:root{color-scheme:light dark;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--bg:#fff;--chip:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9da7b3;--line:#30363d;--bg:#0d1117;--chip:#161b22}}
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:0 16px 48px;color:var(--fg);background:var(--bg)}
header{display:flex;gap:12px;align-items:baseline;border-bottom:1px solid var(--line);padding:12px 0;margin-bottom:16px}
header a{color:inherit;text-decoration:none;font-weight:600}nav{color:var(--muted)}nav a{color:inherit}
table{border-collapse:collapse;width:100%;max-width:1100px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500}code,pre{font:12px/1.45 ui-monospace,monospace}pre{background:var(--chip);padding:12px;overflow:auto;border-radius:6px}
.s{display:inline-block;padding:0 6px;border-radius:4px;background:var(--chip);font-size:12px}
.PASSED{color:#1a7f37}.FAILED{color:#cf222e}.FLAKY,.NEEDS_REVIEW{color:#9a6700}.BLOCKED,.NOT_RUN{color:var(--muted)}
.muted{color:var(--muted)}section{margin:20px 0}h1{font-size:20px}h2{font-size:16px;margin-top:24px}`;

/**
 * A console page: header with the path, the content; no scripts, so nothing in a page runs code (REQ-WEB-01).
 *
 * @param title - Page title (escaped here).
 * @param crumbs - Links of the path, `[label, href]` (escaped here).
 * @param body - Content, already escaped HTML.
 */
export function page(title: string, crumbs: readonly (readonly [string, string])[], body: string): string {
  const nav = crumbs.map(([label, href]) => `<a href="${esc(href)}">${esc(label)}</a>`).join(" / ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · QAJitsu</title><style>${STYLE}</style></head><body><header><a href="/">QAJitsu console</a><nav>${nav}</nav></header><h1>${esc(title)}</h1>${body}</body></html>`;
}

const status = (s: string): string => `<span class="s ${esc(s.replace(/[^A-Z_]/g, ""))}">${esc(s)}</span>`;

/** The projects page. */
export function projectsPage(projects: readonly ConsoleProject[]): string {
  if (projects.length === 0)
    return page(
      "Projects",
      [],
      `<p class="muted">No projects yet: create one with <code>qj init &lt;slug&gt;</code>.</p>`,
    );
  const rows = projects
    .map((p) =>
      p.runsRoot
        ? `<tr><td><a href="/p/${seg(p.slug)}">${esc(p.slug)}</a></td><td class="muted"><code>${esc(p.qaDir)}</code></td></tr>`
        : `<tr><td>${esc(p.slug)}</td><td class="muted">${esc(p.problem ?? "")}</td></tr>`,
    )
    .join("");
  return page("Projects", [], `<table><tr><th>Project</th><th>.qa folder</th></tr>${rows}</table>`);
}

/** A project's tickets. */
export function ticketsPage(
  slug: string,
  tickets: readonly {
    readonly ticket: string;
    readonly latest?: ConsoleRunEntry | undefined;
    readonly runs: number;
  }[],
): string {
  const rows = tickets
    .map(
      (t) =>
        `<tr><td><a href="/p/${seg(slug)}/t/${seg(t.ticket)}">${esc(t.ticket)}</a></td><td>${t.latest ? status(t.latest.status) : ""}</td><td>${esc(t.latest?.createdAt ?? "")}</td><td>${String(t.runs)}</td></tr>`,
    )
    .join("");
  return page(
    slug,
    [[slug, `/p/${seg(slug)}`]],
    tickets.length === 0
      ? `<p class="muted">No runs yet: start with <code>qj fetch &lt;TICKET&gt;</code>.</p>`
      : `<table><tr><th>Ticket</th><th>Latest run</th><th>Started</th><th>Runs</th></tr>${rows}</table>`,
  );
}

/** A ticket's runs. */
export function runsPage(slug: string, ticket: string, runs: readonly ConsoleRunEntry[]): string {
  const rows = runs
    .map(
      (r) =>
        `<tr><td><a href="/p/${seg(slug)}/t/${seg(ticket)}/r/${seg(r.runId)}">${esc(r.runId)}</a></td><td>${status(r.status)}</td><td>${esc(r.createdAt)}</td></tr>`,
    )
    .join("");
  return page(
    ticket,
    [
      [slug, `/p/${seg(slug)}`],
      [ticket, `/p/${seg(slug)}/t/${seg(ticket)}`],
    ],
    `<table><tr><th>Run</th><th>Status</th><th>Started</th></tr>${rows}</table>`,
  );
}

const size = (bytes: number): string =>
  bytes >= 1e6
    ? `${(bytes / 1e6).toFixed(1)} MB`
    : bytes >= 1e3
      ? `${(bytes / 1e3).toFixed(1)} kB`
      : `${String(bytes)} B`;

/** A run: what it computed and stored, with links to its report, evidence and plans (REQ-WEB-01/AC1+AC2). */
export function runPage(slug: string, ticket: string, run: ConsoleRun): string {
  const base = `/p/${seg(slug)}/t/${seg(ticket)}/r/${seg(run.record.runId)}`;
  const results = Object.entries(run.results);
  const facts = [
    ["Status", status(run.record.status)],
    ["Stage", esc(run.record.stage)],
    ["Started", esc(run.record.createdAt)],
    ["Updated", esc(run.record.updatedAt)],
    ...(run.approvedVersion === undefined ? [] : [["Approved plan", `v${String(run.approvedVersion)}`]]),
    ...(run.audit === undefined ? [] : [["Audit", esc(run.audit)]]),
    ...(run.publishedUrl === undefined
      ? []
      : [
          [
            "Published",
            /^https?:\/\//.test(run.publishedUrl)
              ? `<a href="${esc(run.publishedUrl)}" rel="noreferrer">${esc(run.publishedUrl)}</a>`
              : esc(run.publishedUrl),
          ],
        ]),
  ]
    .map(([k, v]) => `<tr><th>${esc(k ?? "")}</th><td>${v ?? ""}</td></tr>`)
    .join("");
  const plans = run.planVersions
    .map(
      (v) =>
        `<a href="${base}/plan/${String(v)}">v${String(v)}</a>${v === run.approvedVersion ? " (approved)" : ""}`,
    )
    .join(" · ");
  const evidence = run.evidence
    .map(
      (e) =>
        `<tr><td><a href="${base}/files/evidence/${e.path.split("/").map(seg).join("/")}">${esc(e.path)}</a></td><td>${esc(e.kind)}</td><td>${size(e.bytes)}</td><td><code>${esc(e.sha256.slice(0, 16))}…</code></td></tr>`,
    )
    .join("");
  return page(
    `${ticket} · ${run.record.runId}`,
    [
      [slug, `/p/${seg(slug)}`],
      [ticket, `/p/${seg(slug)}/t/${seg(ticket)}`],
      [run.record.runId, base],
    ],
    `<section><table>${facts}</table></section>` +
      `<section><h2>Results (computed by the run)</h2>${
        results.length === 0
          ? `<p class="muted">No results yet.</p>`
          : `<table><tr><th>Case</th><th>Status</th></tr>${results.map(([c, s]) => `<tr><td>${esc(c)}</td><td>${status(s)}</td></tr>`).join("")}</table>`
      }${run.hasReport ? `<p><a href="${base}/files/report/report.html">Full report</a></p>` : ""}</section>` +
      (run.matrixMd ? `<section><h2>Matrix</h2><pre>${esc(run.matrixMd)}</pre></section>` : "") +
      `<section><h2>Plans</h2>${plans === "" ? `<p class="muted">No plan yet.</p>` : `<p>${plans}</p>`}</section>` +
      `<section><h2>Evidence (${String(run.evidence.length)} files, by SHA-256)</h2>${
        run.evidence.length === 0
          ? `<p class="muted">No evidence yet.</p>`
          : `<table><tr><th>File</th><th>Kind</th><th>Size</th><th>SHA-256</th></tr>${evidence}</table>`
      }</section>`,
  );
}

/** A plan version as the plan stage wrote it. */
export function planPage(
  slug: string,
  ticket: string,
  runId: string,
  version: number,
  markdown: string,
): string {
  const base = `/p/${seg(slug)}/t/${seg(ticket)}/r/${seg(runId)}`;
  return page(
    `${ticket} · plan v${String(version)}`,
    [
      [slug, `/p/${seg(slug)}`],
      [ticket, `/p/${seg(slug)}/t/${seg(ticket)}`],
      [runId, base],
      [`plan v${String(version)}`, `${base}/plan/${String(version)}`],
    ],
    `<pre>${esc(markdown)}</pre>`,
  );
}

/** A page for something that is not there. */
export function notFoundPage(what: string): string {
  return page("Not found", [], `<p class="muted">${esc(what)}</p>`);
}
