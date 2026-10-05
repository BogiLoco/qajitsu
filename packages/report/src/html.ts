import type { AssertionRecord, Plan, RunObservation, TestStatus } from "@qajitsu/core";
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
    /** Stubbed services: what was not real in this run (REQ-ENV-05/AC2). */
    readonly stubs?: readonly string[] | undefined;
  };
  readonly repos: Readonly<Record<string, string>>;
  /** Auditor and canary notes (REQ-VER-06, REQ-VER-09). */
  readonly checks?: readonly string[] | undefined;
  /** Fix verification: the same reproduction cases before and with the fix (REQ-VER-11/AC4). */
  readonly fixCheck?:
    | {
        readonly verified: boolean;
        readonly baseRun: string;
        readonly repo: string;
        readonly baseSha: string;
        readonly fixSha: string;
        readonly cases: readonly {
          readonly caseId: string;
          readonly before: string;
          readonly after: string;
          readonly specAfter: string;
          readonly verified: boolean;
          readonly reason: string;
        }[];
      }
    | undefined;
  /** Passive observations, computed by code, never statuses (REQ-EVD-07/AC4). */
  readonly observations?: readonly RunObservation[] | undefined;
  readonly gates: readonly {
    readonly gate: string;
    readonly ok: boolean;
    readonly problems: readonly string[];
  }[];
  /** Timeline of the run; `evidencePath` links an event to its screenshot or request/response (REQ-OBS-02/AC2). */
  readonly timeline?:
    | readonly {
        readonly ts: string;
        readonly stage: string;
        readonly actor: string;
        readonly event: string;
        readonly text: string;
        readonly evidencePath?: string | undefined;
      }[]
    | undefined;
  /** Inline SVG of the transition graph (REQ-OBS-06/AC2), rendered by code. */
  readonly graphSvg?: string | undefined;
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

/** Anchor id of an evidence file in the report. */
export const evidenceAnchor = (path: string): string => `ev-${path.replace(/[^A-Za-z0-9_-]/g, "_")}`;

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
              const head = `${esc(e.stepId ?? "")} · ${esc(e.kind)} · <a href="../evidence/${esc(e.path)}">${esc(e.path)}</a> · <code title="SHA-256">${e.sha256.slice(0, 16)}…</code>`;
              const id = evidenceAnchor(e.path);
              if (e.dataUri && safeDataUri(e.dataUri)) {
                return `<figure id="${id}"><figcaption>${head}</figcaption><img alt="${esc(e.path)}" src="${e.dataUri}"></figure>`;
              }
              if (e.kind === "video") {
                return `<figure id="${id}"><figcaption>${head}</figcaption><video controls preload="none" src="../evidence/${esc(e.path)}"></video></figure>`;
              }
              return `<details id="${id}"><summary>${head}</summary>${e.text === undefined ? "" : `<pre>${esc(e.text)}</pre>`}</details>`;
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
  const timeline = (input.timeline ?? [])
    .map(
      (t) =>
        `<tr><td>${esc(t.ts.slice(11, 19))}</td><td>${esc(t.stage)}</td><td>${esc(t.actor)}</td><td>${t.evidencePath ? `<a href="#${evidenceAnchor(t.evidencePath)}">${esc(t.event)}</a>` : esc(t.event)}</td><td>${esc(t.text)}</td></tr>`,
    )
    .join("");
  const repos = Object.entries(input.repos)
    .map(([k, v]) => `${esc(k)} <code>${esc(v)}</code>`)
    .join(", ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src 'self'; style-src 'unsafe-inline'">
<title>QAJitsu ${esc(input.ticket)} · ${esc(input.runId)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:24px;color:#1f2328}
table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top}
.badge{color:#fff;border-radius:10px;padding:1px 8px;font-size:12px;font-weight:600}.tiles{display:flex;gap:12px;flex-wrap:wrap}
.tile{border-left:4px solid;padding:6px 12px;background:#f6f8fa}.tile b{font-size:20px;margin-right:6px}
.muted{color:#57606a}.ok{color:#1a7f37}.bad{color:#cf222e}tr.bad td{background:#ffebe9}pre{background:#f6f8fa;padding:8px;overflow:auto;max-height:400px}
section{border-top:1px solid #d0d7de;margin-top:16px}img,video{max-width:100%}
:target{outline:3px solid #0969da}figure{margin:8px 0}.timeline td{font-size:12px}
</style></head><body>
<h1>${esc(input.ticket)} test report</h1>
<p class="muted">Run ${esc(input.runId)} · ${esc(input.generatedAt)} · environment ${esc(input.environment.name)} (${esc(input.environment.baseUrl)})${input.environment.deployedSha ? ` · deployed <code>${esc(input.environment.deployedSha)}</code>` : ""}${input.environment.stubs?.length ? ` · <strong>stubbed (not real):</strong> ${esc(input.environment.stubs.join(", "))}` : ""}<br>Code: ${repos || "–"} · plan sha256 <code>${esc(input.planSha256.slice(0, 16))}…</code></p>
<div class="tiles">${tiles}</div>
<h2>Summary</h2><p>${esc(input.summary).replace(/\n/g, "<br>")}</p>
${
  input.fixCheck
    ? `<h2>Fix verification: ${input.fixCheck.verified ? '<span class="ok">verified</span>' : '<span class="bad">not verified</span>'}</h2>
<p class="muted">The same approved plan and specs ran on ${esc(input.fixCheck.repo)} <code>${esc(input.fixCheck.baseSha.slice(0, 12))}</code> (before the fix, <a href="../../${esc(input.fixCheck.baseRun)}/report/report.html">run ${esc(input.fixCheck.baseRun)}</a>) and <code>${esc(input.fixCheck.fixSha.slice(0, 12))}</code> (with the fix, this run). A reproduction case must fail before and pass after.</p>
<table><tr><th>TC</th><th>Before the fix</th><th>With the fix</th><th>Spec sha256</th><th>Verdict</th></tr>${input.fixCheck.cases
        .map(
          (c) =>
            `<tr class="${c.verified ? "" : "bad"}"><td><a href="#${esc(c.caseId)}">${esc(c.caseId)}</a></td><td><a href="../../${esc(input.fixCheck?.baseRun ?? "")}/report/report.html#${esc(c.caseId)}">${esc(c.before)}</a></td><td><a href="#${esc(c.caseId)}">${esc(c.after)}</a></td><td><code>${esc(c.specAfter.slice(0, 12))}</code></td><td>${esc(c.reason)}</td></tr>`,
        )
        .join("")}</table>`
    : ""
}
${
  input.observations && input.observations.length > 0
    ? `<h2>Observations (${String(input.observations.length)}, not test results)</h2>
<p class="muted">Found by code while the planned steps ran: contract mismatches, console errors, 4xx/5xx responses and accessibility violations. They do not change any status or count.</p>
<table><tr><th>TC</th><th>Kind</th><th>Observation</th></tr>${input.observations.map((o) => `<tr><td>${esc(o.caseId)}</td><td>${esc(o.kind)}</td><td>${esc(o.text)}</td></tr>`).join("")}</table>`
    : ""
}
<h2>Matrix</h2><table><tr><th>TC</th><th>Title</th><th>Requirement</th><th>Type</th><th>Status</th><th>Steps OK</th><th>Evidence</th></tr>${matrix}</table>
<h2>Publish gates</h2><ul>${gates}</ul>
${input.checks && input.checks.length > 0 ? `<h2>Verification checks</h2><ul>${input.checks.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
${input.graphSvg ? `<h2>Transition graph</h2><div class="graph">${input.graphSvg}</div>` : ""}
${timeline ? `<h2>Timeline</h2><table class="timeline"><tr><th>Time</th><th>Stage</th><th>Actor</th><th>Event</th><th>Details</th></tr>${timeline}</table>` : ""}
<h2>Cases</h2>${cases}
</body></html>
`;
}
