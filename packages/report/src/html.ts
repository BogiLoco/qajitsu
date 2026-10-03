import type { AssertionRecord, Plan, TestStatus } from "@qajitsu/core";
import { countStatuses, type MatrixRow } from "./matrix.js";

/** One evidence file shown in the report, referenced by hash (REQ-VER-05/AC2). */
export interface ReportEvidence {
  readonly path: string;
  readonly sha256: string;
  readonly kind: string;
  readonly stepId?: string | undefined;
  /** Text content embedded in the report (API calls, logs); masked before it gets here. */
  readonly text?: string | undefined;
  /** Image as a data URI (screenshots), embedded so the file is self-contained. */
  readonly dataUri?: string | undefined;
}

/** One attempt of one case, as shown in the report. */
export interface ReportAttempt {
  readonly attempt: number;
  readonly outcome: string;
  readonly error?: string | undefined;
  readonly assertions: readonly AssertionRecord[];
  readonly evidence: readonly ReportEvidence[];
}

/** Input of {@link renderReportHtml}. */
export interface ReportInput {
  readonly ticket: string;
  readonly summary: string;
  readonly runId: string;
  readonly generatedAt: string;
  readonly plan: Plan;
  readonly planSha256: string;
  readonly rows: readonly MatrixRow[];
  readonly attempts: Readonly<Record<string, readonly ReportAttempt[]>>;
  readonly environment: {
    readonly name: string;
    readonly baseUrl: string;
    readonly deployedSha?: string | undefined;
  };
  readonly repos: Readonly<Record<string, string>>;
  readonly gates: readonly {
    readonly gate: string;
    readonly ok: boolean;
    readonly problems: readonly string[];
  }[];
}

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const fmt = (v: unknown): string => JSON.stringify(v) || "undefined";

const STATUS_COLOR: Record<TestStatus, string> = {
  PASSED: "#1a7f37",
  FAILED: "#cf222e",
  FLAKY: "#9a6700",
  BLOCKED: "#8250df",
  NOT_RUN: "#57606a",
  NEEDS_REVIEW: "#bc4c00",
};

const badge = (status: TestStatus): string =>
  `<span class="badge" style="background:${STATUS_COLOR[status]}">${status}</span>`;

const safeDataUri = (uri: string): boolean =>
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(uri);

/**
 * Renders `report/report.html`: one self-contained file with summary, matrix, steps, assertions and
 * evidence (REQ-EVD-05/AC3). Numbers come from `rows` (invariant 6); all text is HTML-escaped.
 *
 * @param input - Computed report data.
 */
export function renderReportHtml(input: ReportInput): string {
  const counts = countStatuses(input.rows);
  const tiles = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(
      ([s, n]) =>
        `<div class="tile" style="border-color:${STATUS_COLOR[s as TestStatus]}"><b>${String(n)}</b><span>${s}</span></div>`,
    )
    .join("");
  const matrix = input.rows
    .map(
      (r) =>
        `<tr><td><a href="#${esc(r.caseId)}">${esc(r.caseId)}</a></td><td>${esc(r.title)}</td><td>${esc(r.requirement)}</td><td>${r.type.toUpperCase()}</td><td>${badge(r.status)}</td><td>${String(r.stepsPassed)}/${String(r.stepsTotal)}</td><td>${esc(r.evidence)}</td></tr>`,
    )
    .join("");
  const cases = input.plan.cases
    .map((c) => {
      const row = input.rows.find((r) => r.caseId === c.id);
      const attempts = input.attempts[c.id] ?? [];
      const steps = c.steps
        .map(
          (s) =>
            `<li><b>${esc(s.id)}</b> ${esc(s.action)}<br><span class="muted">Expected: ${esc(s.expect.description)}${s.expect.status === undefined ? "" : ` · status ${String(s.expect.status)}`}${s.expect.fields ? ` · ${esc(JSON.stringify(s.expect.fields))}` : ""}</span></li>`,
        )
        .join("");
      const attemptHtml = attempts
        .map((a) => {
          const assertions = a.assertions
            .map(
              (x) =>
                `<tr class="${x.pass ? "ok" : "bad"}"><td>${esc(x.stepId)}</td><td>${esc(x.field)}</td><td><code>${esc(fmt(x.expected))}</code></td><td><code>${esc(fmt(x.actual))}</code></td><td>${x.pass ? "✔" : "✘"}</td></tr>`,
            )
            .join("");
          const evidence = a.evidence
            .map((e) => {
              const body =
                e.dataUri && safeDataUri(e.dataUri)
                  ? `<img alt="${esc(e.path)}" src="${e.dataUri}">`
                  : e.text === undefined
                    ? ""
                    : `<pre>${esc(e.text)}</pre>`;
              return `<details><summary>${esc(e.stepId ?? "")} · ${esc(e.kind)} · <a href="../evidence/${esc(e.path)}">${esc(e.path)}</a> · <code title="SHA-256">${e.sha256.slice(0, 16)}…</code></summary>${body}</details>`;
            })
            .join("");
          return `<h4>Attempt ${String(a.attempt)}: ${esc(a.outcome)}</h4>${a.error ? `<p class="bad">${esc(a.error)}</p>` : ""}${assertions ? `<table><tr><th>Step</th><th>Field</th><th>Expected</th><th>Actual</th><th></th></tr>${assertions}</table>` : '<p class="muted">No assertions recorded.</p>'}${evidence}`;
        })
        .join("");
      return `<section id="${esc(c.id)}"><h3>${esc(c.id)}: ${esc(c.title)} ${row ? badge(row.status) : ""}</h3><ol>${steps}</ol>${attemptHtml || '<p class="muted">Not run.</p>'}</section>`;
    })
    .join("");
  const gates = input.gates
    .map(
      (g) =>
        `<li class="${g.ok ? "ok" : "bad"}">${g.ok ? "✔" : "✘"} ${esc(g.gate)}${g.problems.length > 0 ? `<ul>${g.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}</li>`,
    )
    .join("");
  const repos = Object.entries(input.repos)
    .map(([k, v]) => `${esc(k)} <code>${esc(v)}</code>`)
    .join(", ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>QAJitsu ${esc(input.ticket)} · ${esc(input.runId)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:24px;color:#1f2328}
table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top}
.badge{color:#fff;border-radius:10px;padding:1px 8px;font-size:12px;font-weight:600}.tiles{display:flex;gap:12px;flex-wrap:wrap}
.tile{border-left:4px solid;padding:6px 12px;background:#f6f8fa}.tile b{font-size:20px;margin-right:6px}
.muted{color:#57606a}.ok{color:#1a7f37}.bad{color:#cf222e}tr.bad td{background:#ffebe9}pre{background:#f6f8fa;padding:8px;overflow:auto;max-height:400px}
section{border-top:1px solid #d0d7de;margin-top:16px}img{max-width:100%}
</style></head><body>
<h1>${esc(input.ticket)} test report</h1>
<p class="muted">Run ${esc(input.runId)} · ${esc(input.generatedAt)} · environment ${esc(input.environment.name)} (${esc(input.environment.baseUrl)})${input.environment.deployedSha ? ` · deployed <code>${esc(input.environment.deployedSha)}</code>` : ""}<br>Code: ${repos || "–"} · plan sha256 <code>${esc(input.planSha256.slice(0, 16))}…</code></p>
<div class="tiles">${tiles}</div>
<h2>Summary</h2><p>${esc(input.summary).replace(/\n/g, "<br>")}</p>
<h2>Matrix</h2><table><tr><th>TC</th><th>Title</th><th>Requirement</th><th>Type</th><th>Status</th><th>Steps OK</th><th>Evidence</th></tr>${matrix}</table>
<h2>Publish gates</h2><ul>${gates}</ul>
<h2>Cases</h2>${cases}
</body></html>
`;
}
