import type { Plan } from "@qajitsu/core";
import { esc, page } from "./pages.js";
import type { PlanReview } from "./review.js";

const seg = (s: string): string => encodeURIComponent(s);
type Case = Plan["cases"][number];

const REVIEW_STYLE = `<style>
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:900px){.cols{grid-template-columns:1fr}}
.case{border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:8px 0}
.case.added{border-left:4px solid #1a7f37}.case.removed{border-left:4px solid #cf222e;opacity:.75}.case.changed{border-left:4px solid #9a6700}
.case h3{font-size:14px;margin:0 0 4px}.tag{font-size:11px;color:var(--muted);text-transform:uppercase;margin-left:6px}
ol{margin:4px 0 0 18px;padding:0}li{margin:2px 0}.gap{color:#cf222e}form{margin:8px 0}textarea{width:100%;max-width:1100px;font:12px ui-monospace,monospace}
fieldset{border:1px solid var(--line);border-radius:6px;padding:8px 12px;margin:12px 0;max-width:1100px}button{font:inherit;padding:4px 12px}
</style>`;

/** One case as the reviewer reads it: what it does, step by step, and what it rests on. */
function caseCard(c: Case | undefined, mark: "" | "added" | "removed" | "changed"): string {
  if (!c) return `<div class="case muted">—</div>`;
  const steps = c.steps
    .map(
      (s) =>
        `<li><code>${esc(s.id)}</code> ${esc(s.action)}<br><span class="muted">expect ${esc(JSON.stringify(s.expect))}</span></li>`,
    )
    .join("");
  const sources = c.source
    .map((s) => esc("id" in s && typeof s.id === "string" ? `${s.kind} ${s.id}` : s.kind))
    .join(", ");
  return `<div class="case ${mark}"><h3>${esc(c.id)} ${esc(c.title)}<span class="tag">${esc(c.type)} · ${esc(c.priority)}${mark ? ` · ${mark}` : ""}</span></h3><div class="muted">sources: ${sources}</div><ol>${steps}</ol></div>`;
}

/**
 * The plan review screen (REQ-WEB-07): two versions side by side with added, removed and changed cases (AC1), the
 * coverage matrix and the "changed but not tested" list (AC2), and approve, revise and edit as explicit buttons (AC3).
 *
 * @param slug - Project.
 * @param ticket - Ticket key.
 * @param runId - Run id.
 * @param review - What to show.
 * @param csrf - The form token of the signed-in session.
 * @param planYaml - The version under review as YAML, for editing.
 */
export function reviewPage(
  slug: string,
  ticket: string,
  runId: string,
  review: PlanReview,
  csrf: string,
  planYaml: string,
): string {
  const base = `/p/${seg(slug)}/t/${seg(ticket)}/r/${seg(runId)}`;
  const right = review.right;
  const left = review.left;
  const ids = [...new Set([...(left?.cases ?? []).map((c) => c.id), ...right.cases.map((c) => c.id)])].sort();
  const markOf = (id: string): "" | "added" | "removed" | "changed" =>
    review.diff?.added.includes(id) === true
      ? "added"
      : review.diff?.removed.includes(id) === true
        ? "removed"
        : review.diff?.changed.includes(id) === true
          ? "changed"
          : "";
  const versionLinks = review.versions
    .map(
      (v) =>
        `<a href="${base}/review?right=${String(v)}">v${String(v)}</a>${v === review.approvedVersion ? " (approved)" : ""}`,
    )
    .join(" · ");
  const compare = left
    ? `<p>Comparing <strong>v${String(left.version)}</strong> (left) with <strong>v${String(right.version)}</strong> (right): ${String(review.diff?.added.length ?? 0)} added, ${String(review.diff?.removed.length ?? 0)} removed, ${String(review.diff?.changed.length ?? 0)} changed.</p>
       <div class="cols"><div><h2>v${String(left.version)}</h2>${ids
         .map((id) =>
           caseCard(
             left.cases.find((c) => c.id === id),
             markOf(id) === "removed" ? "removed" : "",
           ),
         )
         .join("")}</div>
       <div><h2>v${String(right.version)}</h2>${ids
         .map((id) =>
           caseCard(
             right.cases.find((c) => c.id === id),
             markOf(id) === "removed" ? "" : markOf(id),
           ),
         )
         .join("")}</div></div>`
    : `<h2>v${String(right.version)}</h2>${right.cases.map((c) => caseCard(c, "")).join("")}`;
  const gaps = review.coverage.filter((r) => !r.covered);
  const matrix = `<table><tr><th>Criterion or endpoint</th><th>Covered by</th></tr>${review.coverage
    .map(
      (r) =>
        `<tr${r.covered ? "" : ' class="gap"'}><td><strong>${esc(r.id)}</strong>${r.text ? ` ${esc(r.text)}` : ""}</td><td>${
          r.cases.length > 0
            ? esc(r.cases.join(", "))
            : r.existing.length > 0
              ? `existing test ${esc(r.existing.join(", "))}`
              : r.excluded !== undefined
                ? `<span class="muted">excluded: ${esc(r.excluded)}</span>`
                : "nothing"
        }</td></tr>`,
    )
    .join("")}</table>`;
  const risks =
    gaps.length === 0
      ? `<p class="muted">Every criterion and changed endpoint is covered or excluded with a reason.</p>`
      : `<ul>${gaps.map((g) => `<li class="gap"><strong>${esc(g.id)}</strong>${g.text ? ` ${esc(g.text)}` : ""}</li>`).join("")}</ul>`;
  const questions =
    right.open_questions.length === 0
      ? ""
      : `<section><h2>Open questions</h2><ul>${right.open_questions.map((q) => `<li><strong>${esc(q.id)}</strong> ${esc(q.question)}</li>`).join("")}</ul></section>`;
  const token = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const actions =
    review.approvedVersion !== undefined
      ? `<p>Plan v${String(review.approvedVersion)} is approved and frozen; nothing here changes it.</p>`
      : `<fieldset><legend>Approve v${String(right.version)}</legend><form method="post" action="${base}/approve">${token}<input type="hidden" name="version" value="${String(right.version)}">
           <label><input type="checkbox" name="confirm_uncovered" value="1"> approve although ${String(gaps.length)} item(s) are covered by no case</label><br>
           <label><input type="checkbox" name="confirm_placeholders" value="1"> approve expectations code cannot check as written</label><br>
           <label><input type="checkbox" name="confirm_open_questions" value="1"> approve with ${String(right.open_questions.length)} open question(s)</label><br>
           <button type="submit">Approve and freeze v${String(right.version)}</button></form></fieldset>
         <fieldset><legend>Revise</legend><form method="post" action="${base}/revise">${token}<textarea name="instruction" rows="3" required placeholder="What should change? The planner writes a new version."></textarea><br><button type="submit">Ask for a new version</button></form></fieldset>
         <fieldset><legend>Edit v${String(right.version)}</legend><form method="post" action="${base}/edit">${token}<textarea name="plan" rows="18">${esc(planYaml)}</textarea><br><button type="submit">Store as a new version</button></form></fieldset>`;
  return page(
    `${ticket} · plan review`,
    [
      [slug, `/p/${seg(slug)}`],
      [ticket, `/p/${seg(slug)}/t/${seg(ticket)}`],
      [runId, base],
      ["plan review", `${base}/review`],
    ],
    `${REVIEW_STYLE}<p>Versions: ${versionLinks}</p>${compare}${questions}<section><h2>Coverage (computed by code)</h2>${matrix}</section><section><h2>Changed but not tested</h2>${risks}</section><section><h2>Decide</h2>${actions}</section>`,
  );
}

/** What an action did: the command's own output, and the way back. */
export function actionPage(title: string, backHref: string, ok: boolean, output: string): string {
  return page(
    title,
    [],
    `<p class="${ok ? "" : "gap"}">${ok ? "Done." : "Not done."}</p><pre>${esc(output)}</pre><p><a href="${esc(backHref)}">Back to the plan review</a></p>`,
  );
}
