import type { EvidenceEntry, ExploreSession } from "@qajitsu/core";

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Evidence paths in the report are relative to the session folder; the file name says what it is. */
const link = (path: string): string => `evidence/${path}`;

const END_REASON: Record<ExploreSession["endReason"], string> = {
  finished: "the explorer finished",
  "time-box": "the time box was reached (enforced by QAJitsu)",
  "step-budget": "the step budget was used (enforced by QAJitsu)",
  error: "the session stopped with an error",
};

const describeAction = (a: ExploreSession["actions"][number]): string =>
  `${a.action} ${a.target}${a.value !== undefined ? ` = "${a.value}"` : ""}`;

/**
 * Renders the review report of an exploratory session as Markdown (REQ-EXEC-15/AC6). Observations are proposals
 * for a person; the report carries no statuses or counts of passed or failed tests. Evidence is referenced by path
 * and SHA-256 from the manifest (invariant 7).
 *
 * @param session - The validated session.
 * @param manifest - The session's evidence manifest.
 */
export function renderExploreMarkdown(session: ExploreSession, manifest: readonly EvidenceEntry[]): string {
  const hash = new Map(manifest.map((e) => [e.path, e.sha256]));
  const ref = (path: string | undefined): string =>
    path === undefined ? "–" : `[${path}](${link(path)}) \`${(hash.get(path) ?? "missing").slice(0, 12)}\``;
  const byId = new Map(session.actions.map((a) => [a.id, a]));
  const out = [
    `# Exploratory session ${session.id} for ${session.ticket}`,
    "",
    `Goal: ${session.goal}`,
    "",
    `Run ${session.run} · environment ${session.environment.name} (${session.environment.baseUrl}) · model ${session.model}`,
    `${session.startedAt} – ${session.endedAt} · ended because ${END_REASON[session.endReason]}${session.error ? `: ${session.error}` : ""}`,
    `Budget: ${String(session.budget.minutes)} min, ${String(session.budget.steps)} actions; used ${String(session.actions.length)} actions.`,
    "",
    "> Observations are proposals from an agent for a person to assess. They are not test results; turn one into a",
    "> plan case with `qajitsu explore promote`, and it runs only after the plan is approved.",
    "",
    "## Summary",
    "",
    session.summary || "_(no summary)_",
    "",
    `## Observations (${String(session.observations.length)})`,
    "",
  ];
  if (session.observations.length === 0) out.push("_(none)_", "");
  for (const o of session.observations) {
    out.push(`### ${o.id} · ${o.title}`, "", `${o.kind}, severity ${o.severity}`, "", o.description, "");
    if (o.expected) out.push(`- Expected: ${o.expected}`);
    if (o.actual) out.push(`- Actual: ${o.actual}`);
    out.push("", "Steps to reproduce:", "");
    o.steps.forEach((id, i) => {
      const a = byId.get(id);
      out.push(
        `${String(i + 1)}. ${id} ${a ? `${describeAction(a)} → ${a.url}` : "(unknown action)"} · ${ref(a?.screenshot)}`,
      );
    });
    out.push("");
  }
  out.push(
    "## Actions",
    "",
    "| Action | What | Result | Page | Screenshot |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const a of session.actions)
    out.push(
      `| ${a.id} | ${describeAction(a).replace(/\|/g, "\\|")} | ${a.ok ? "ok" : `error: ${(a.error ?? "").replace(/\|/g, "\\|")}`} | ${a.url} | ${ref(a.screenshot)} |`,
    );
  out.push("", "## Recordings", "", ...session.recordings.map((r) => `- ${ref(r)}`), "");
  return `${out.join("\n")}\n`;
}

/**
 * Renders the review report of an exploratory session as a self-contained HTML page next to its `evidence/`
 * folder (REQ-EXEC-15/AC6): observations with the screenshots of their steps, the action timeline and the
 * recordings. Every text from the agent or the application is escaped.
 *
 * @param session - The validated session.
 * @param manifest - The session's evidence manifest.
 */
export function renderExploreHtml(session: ExploreSession, manifest: readonly EvidenceEntry[]): string {
  const hash = new Map(manifest.map((e) => [e.path, e.sha256]));
  const sha = (path: string): string => esc((hash.get(path) ?? "missing").slice(0, 12));
  const byId = new Map(session.actions.map((a) => [a.id, a]));
  const shot = (path: string | undefined, caption: string): string =>
    path === undefined
      ? ""
      : `<figure><a href="${esc(link(path))}"><img src="${esc(link(path))}" alt="${esc(caption)}" loading="lazy"></a><figcaption class="muted">${esc(caption)} · sha256 <code>${sha(path)}</code></figcaption></figure>`;
  const observations = session.observations
    .map((o) => {
      const steps = o.steps
        .map((id) => {
          const a = byId.get(id);
          return `<li><a href="#${esc(id)}">${esc(id)}</a> ${a ? `${esc(describeAction(a))} → <code>${esc(a.url)}</code>` : "(unknown action)"}${shot(a?.screenshot, `${id} after the action`)}</li>`;
        })
        .join("");
      return `<section id="${esc(o.id)}" class="obs ${esc(o.severity)}"><h3>${esc(o.id)} · ${esc(o.title)}</h3>
<p><span class="tag">${esc(o.kind)}</span> <span class="tag sev">severity ${esc(o.severity)}</span></p>
<p>${esc(o.description).replace(/\n/g, "<br>")}</p>
${o.expected ? `<p><b>Expected:</b> ${esc(o.expected)}</p>` : ""}${o.actual ? `<p><b>Actual:</b> ${esc(o.actual)}</p>` : ""}
<p><b>Steps to reproduce</b></p><ol>${steps}</ol>
<p class="muted">Turn it into a plan case: <code>qajitsu explore promote ${esc(session.ticket)} --run ${esc(session.run)} --session ${esc(session.id)} --observation ${esc(o.id)}</code></p></section>`;
    })
    .join("\n");
  const timeline = session.actions
    .map(
      (a) =>
        `<tr id="${esc(a.id)}" class="${a.ok ? "" : "bad"}"><td>${esc(a.id)}</td><td>${esc(a.at)}</td><td>${esc(describeAction(a))}</td><td>${a.ok ? "ok" : `error: ${esc(a.error ?? "")}`}</td><td><code>${esc(a.url)}</code></td><td>${a.screenshot ? `<a href="${esc(link(a.screenshot))}">${esc(a.screenshot)}</a>` : "–"}</td></tr>`,
    )
    .join("\n");
  const recordings = session.recordings
    .map((r) =>
      r.endsWith(".webm")
        ? `<figure><video src="${esc(link(r))}" controls preload="metadata"></video><figcaption class="muted">${esc(r)} · sha256 <code>${sha(r)}</code></figcaption></figure>`
        : `<li><a href="${esc(link(r))}">${esc(r)}</a> · sha256 <code>${sha(r)}</code></li>`,
    )
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'unsafe-inline'">
<title>${esc(session.ticket)} exploratory session ${esc(session.id)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:24px;color:#1f2328}
table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top;font-size:12px}
.muted{color:#57606a}tr.bad td{background:#ffebe9}img,video{max-width:100%;border:1px solid #d0d7de}figure{margin:8px 0}
.note{background:#fff8c5;border:1px solid #d4a72c;padding:8px 12px}.tag{background:#eaeef2;border-radius:10px;padding:1px 8px;font-size:12px}
.obs{border-top:1px solid #d0d7de;margin-top:16px}.obs ol li{margin-bottom:12px}.obs figure img{max-width:420px;max-height:300px;object-fit:contain;object-position:top left}.obs.high .sev{background:#ffebe9}.obs.medium .sev{background:#fff8c5}
:target{outline:3px solid #0969da}
</style></head><body>
<h1>${esc(session.ticket)} · exploratory session ${esc(session.id)}</h1>
<p><b>Goal:</b> ${esc(session.goal)}</p>
<p class="muted">Run ${esc(session.run)} · environment ${esc(session.environment.name)} (${esc(session.environment.baseUrl)}) · model ${esc(session.model)}<br>
${esc(session.startedAt)} – ${esc(session.endedAt)} · ended because ${esc(END_REASON[session.endReason])}${session.error ? `: ${esc(session.error)}` : ""} · ${String(session.actions.length)} of ${String(session.budget.steps)} actions, ${String(session.budget.minutes)} min time box</p>
<p class="note">Observations are proposals from an agent for a person to assess. They are not test results.</p>
<h2>Summary</h2><p>${esc(session.summary || "(no summary)").replace(/\n/g, "<br>")}</p>
<h2>Observations (${String(session.observations.length)})</h2>
${observations || '<p class="muted">(none)</p>'}
<h2>Actions</h2>
<table><tr><th>Action</th><th>Time</th><th>What</th><th>Result</th><th>Page</th><th>Screenshot</th></tr>
${timeline}
</table>
<h2>Recordings</h2>
<ul>${recordings}</ul>
</body></html>
`;
}
