import type { ChecklistItem, Finding } from "@qajitsu/core";

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Agent or tool text made inert in Markdown (security review L6): no image, link, autolink or HTML can come out of it,
 * so a rendered `report.md` loads nothing and links nowhere the text did not say in plain words.
 *
 * @param text - Text from the explorer, the tool or the application.
 */
export const mdText = (text: string): string => text.replace(/[\\[\]!<>]/g, (c) => `\\${c}`);

/** What a report section needs from a session: its claims and the explorer's comment. */
export interface SessionClaims {
  readonly checklist: readonly ChecklistItem[];
  readonly findings: readonly Finding[];
  readonly summary: string;
}

const SOURCE = {
  person: "from the person (--check)",
  explorer: "written by the explorer from the goal: compare it with the goal",
} as const;

/**
 * Checklist, findings and the explorer's comment of a session as Markdown (REQ-EXEC-25/AC5). Done items and findings
 * name the actions that show them; the comment comes last, after the claims code checked.
 *
 * @param session - Checklist, findings and comment.
 * @param describe - One line for an action id (what it did and its result).
 */
export function renderClaimsMarkdown(session: SessionClaims, describe: (id: string) => string): string[] {
  const cell = (s: string): string => mdText(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const out = ["## Checklist", ""];
  if (session.checklist.length === 0) out.push("_(no checklist: the explorer gave no accepted answer)_", "");
  else {
    out.push(
      `Items ${SOURCE[session.checklist[0]?.source ?? "person"]}.`,
      "",
      "| # | Item | Done by |",
      "| --- | --- | --- |",
    );
    session.checklist.forEach((c, i) => {
      out.push(
        `| ${String(i + 1)} | ${cell(c.item)} | ${c.actions.length > 0 ? cell(c.actions.map(describe).join("; ")) : `**not done**: ${cell(c.notDone ?? "")}`}${c.corrected ? ` _(corrected by code: ${cell(c.corrected)})_` : ""} |`,
      );
    });
    out.push("");
  }
  out.push(`## Findings (${String(session.findings.length)})`, "");
  if (session.findings.length === 0) out.push("_(none)_");
  for (const f of session.findings) out.push(`- ${mdText(f.text)} (${f.actions.map(describe).join("; ")})`);
  out.push("", "## Explorer's comment", "", session.summary ? mdText(session.summary) : "_(none)_", "");
  return out;
}

/**
 * Checklist, findings and the explorer's comment of a session as HTML (REQ-EXEC-25/AC5); every text is escaped and
 * action ids link to the action timeline.
 *
 * @param session - Checklist, findings and comment.
 */
export function renderClaimsHtml(session: SessionClaims): string {
  const refs = (ids: readonly string[]): string =>
    ids.map((id) => `<a href="#${esc(id)}">${esc(id)}</a>`).join(", ");
  const rows = session.checklist
    .map(
      (c, i) =>
        `<tr class="${c.actions.length > 0 ? "" : "bad"}"><td>${String(i + 1)}</td><td>${esc(c.item)}</td><td>${c.actions.length > 0 ? refs(c.actions) : `<b>not done</b>: ${esc(c.notDone ?? "")}`}${c.corrected ? ` <i class="muted">(corrected by code: ${esc(c.corrected)})</i>` : ""}</td></tr>`,
    )
    .join("\n");
  const checklist =
    session.checklist.length === 0
      ? '<p class="muted">(no checklist: the explorer gave no accepted answer)</p>'
      : `<p class="muted">Items ${esc(SOURCE[session.checklist[0]?.source ?? "person"])}.</p>
<table><tr><th>#</th><th>Item</th><th>Done by</th></tr>
${rows}
</table>`;
  const findings = session.findings.map((f) => `<li>${esc(f.text)} (${refs(f.actions)})</li>`).join("\n");
  return `<h2>Checklist</h2>
${checklist}
<h2>Findings (${String(session.findings.length)})</h2>
${findings ? `<ul>${findings}</ul>` : '<p class="muted">(none)</p>'}
<h2>Explorer's comment</h2><p>${esc(session.summary || "(none)").replace(/\n/g, "<br>")}</p>`;
}
