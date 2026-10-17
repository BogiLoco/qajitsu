import type { CliExploreSession, EvidenceEntry } from "@qajitsu/core";
import { renderClaimsHtml, renderClaimsMarkdown } from "./explore-claims.js";

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const link = (path: string): string => `evidence/${path}`;

const END_REASON: Record<CliExploreSession["endReason"], string> = {
  finished: "the explorer finished",
  "time-box": "the time box was reached (enforced by QAJitsu)",
  "step-budget": "the step budget was used (enforced by QAJitsu)",
  error: "the session stopped with an error",
};

type Action = CliExploreSession["actions"][number];

/** One line saying what an action did, e.g. `run qj env up DEMO-4 ← yes`. */
export function describeCliAction(a: Action, tool: string): string {
  const what =
    a.action === "run" || a.action === "start"
      ? `${a.action} ${[tool, ...a.args].join(" ")}`
      : a.action === "send"
        ? `send "${(a.input ?? []).join(" ")}" to ${a.background ?? "?"}`
        : a.action === "signal"
          ? `${a.signal ?? "signal"} to ${a.background ?? "?"}`
          : a.action === "wait"
            ? `wait for ${a.background ?? "?"}`
            : a.action === "read" || a.action === "list"
              ? `${a.action} ${a.path ?? "."}`
              : "list leftovers";
  return `${what}${a.input && a.action === "run" ? ` ← ${a.input.join(" / ")}` : ""}`;
}

/** How an action ended, e.g. `exit 2`, `still running`, `stopped by the timeout`. */
export function cliResult(a: Action): string {
  if (a.running) return "still running";
  if (a.timedOut) return "stopped by the timeout";
  if (a.exitCode !== undefined) return `exit ${String(a.exitCode)}`;
  if (a.endedBy) return `ended by ${a.endedBy}`;
  return a.ok ? "ok" : `error${a.error ? `: ${a.error}` : ""}`;
}

/**
 * Renders the review report of a command-line exploratory session as Markdown (REQ-EXEC-24/AC5): the goal, every
 * command with its exit code, changed files and output by SHA-256, the observations with their steps, what was left
 * running and what the clean-up stopped. Observations are proposals for a person, never statuses.
 *
 * @param session - The validated session.
 * @param manifest - The session's evidence manifest.
 */
export function renderCliExploreMarkdown(
  session: CliExploreSession,
  manifest: readonly EvidenceEntry[],
): string {
  const hash = new Map(manifest.map((e) => [e.path, e.sha256]));
  const ref = (path: string | undefined): string =>
    path === undefined ? "–" : `[${path}](${link(path)}) \`${(hash.get(path) ?? "missing").slice(0, 12)}\``;
  const tool = session.tool.name;
  const byId = new Map(session.actions.map((a) => [a.id, a]));
  const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const out = [
    `# Exploratory session ${session.id} of \`${tool}\` for ${session.ticket}`,
    "",
    `Goal: ${session.goal}`,
    "",
    `Run ${session.run} · command \`${session.tool.command.join(" ")}\` · model ${session.model}`,
    `${session.startedAt} – ${session.endedAt} · ended because ${END_REASON[session.endReason]}${session.error ? `: ${session.error}` : ""}`,
    `Budget: ${String(session.budget.minutes)} min, ${String(session.budget.steps)} actions; used ${String(session.actions.length)} actions.`,
    "",
    "> Observations are proposals from an agent for a person to assess. They are not test results; turn one into a",
    "> regression test proposal with `qajitsu explore promote`.",
    "",
    ...renderClaimsMarkdown(session, (id) => {
      const a = byId.get(id);
      return a ? `${id} \`${describeCliAction(a, tool)}\` → ${cliResult(a)}` : id;
    }),
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
        `${String(i + 1)}. ${id} ${a ? `\`${describeCliAction(a, tool)}\` → ${cliResult(a)} · ${ref(a.output)}` : "(unknown action)"}`,
      );
    });
    out.push("");
  }
  out.push(
    "## Actions",
    "",
    "| Action | Command | Result | Time | Changed files | Output |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const a of session.actions)
    out.push(
      `| ${a.id} | ${cell(describeCliAction(a, tool))} | ${cell(cliResult(a))} | ${String(a.durationMs)} ms | ${cell(a.changed.slice(0, 10).join(", ") || "–")}${a.changed.length > 10 ? ` (+${String(a.changed.length - 10)})` : ""} | ${ref(a.output)} |`,
    );
  out.push(
    "",
    "## Left running at the end",
    "",
    ...(session.leftovers.processes.length + session.leftovers.containers.length === 0
      ? ["Nothing."]
      : [
          ...session.leftovers.processes.map((p) => `- process ${p}`),
          ...session.leftovers.containers.map((c) => `- container ${c}`),
        ]),
    "",
    "## Stopped by the clean-up",
    "",
    ...(session.cleaned.processes.length + session.cleaned.containers.length === 0
      ? ["Nothing."]
      : [
          ...session.cleaned.processes.map((p) => `- process ${p}`),
          ...session.cleaned.containers.map((c) => `- container ${c}`),
        ]),
    "",
    ...(session.refusedHosts.length > 0
      ? ["## Network refused by the allowlist", "", ...session.refusedHosts.map((h) => `- ${h}`), ""]
      : []),
  );
  return `${out.join("\n")}\n`;
}

/**
 * Renders the review report of a command-line exploratory session as a self-contained HTML page next to its
 * `evidence/` folder (REQ-EXEC-24/AC5). Every text from the agent or the tool is escaped.
 *
 * @param session - The validated session.
 * @param manifest - The session's evidence manifest.
 */
export function renderCliExploreHtml(session: CliExploreSession, manifest: readonly EvidenceEntry[]): string {
  const hash = new Map(manifest.map((e) => [e.path, e.sha256]));
  const sha = (path: string): string => esc((hash.get(path) ?? "missing").slice(0, 12));
  const tool = session.tool.name;
  const byId = new Map(session.actions.map((a) => [a.id, a]));
  const output = (path: string | undefined): string =>
    path === undefined ? "–" : `<a href="${esc(link(path))}">output</a> <code>${sha(path)}</code>`;
  const observations = session.observations
    .map((o) => {
      const steps = o.steps
        .map((id) => {
          const a = byId.get(id);
          return `<li><a href="#${esc(id)}">${esc(id)}</a> ${a ? `<code>${esc(describeCliAction(a, tool))}</code> → ${esc(cliResult(a))} · ${output(a.output)}` : "(unknown action)"}</li>`;
        })
        .join("");
      return `<section id="${esc(o.id)}" class="obs ${esc(o.severity)}"><h3>${esc(o.id)} · ${esc(o.title)}</h3>
<p><span class="tag">${esc(o.kind)}</span> <span class="tag sev">severity ${esc(o.severity)}</span></p>
<p>${esc(o.description).replace(/\n/g, "<br>")}</p>
${o.expected ? `<p><b>Expected:</b> ${esc(o.expected)}</p>` : ""}${o.actual ? `<p><b>Actual:</b> ${esc(o.actual)}</p>` : ""}
<p><b>Steps to reproduce</b></p><ol>${steps}</ol>
<p class="muted">Turn it into a regression test proposal: <code>qajitsu explore promote ${esc(session.ticket)} --run ${esc(session.run)} --session ${esc(session.id)} --observation ${esc(o.id)}</code></p></section>`;
    })
    .join("\n");
  const timeline = session.actions
    .map(
      (a) =>
        `<tr id="${esc(a.id)}" class="${a.ok || a.running ? "" : "bad"}"><td>${esc(a.id)}</td><td>${esc(a.at)}</td><td><code>${esc(describeCliAction(a, tool))}</code></td><td>${esc(cliResult(a))}</td><td>${String(a.durationMs)} ms</td><td>${esc(a.changed.slice(0, 10).join(", ") || "–")}${a.changed.length > 10 ? ` (+${String(a.changed.length - 10)})` : ""}</td><td>${output(a.output)}</td></tr>`,
    )
    .join("\n");
  const list = (items: { readonly processes: readonly string[]; readonly containers: readonly string[] }) =>
    items.processes.length + items.containers.length === 0
      ? '<p class="muted">Nothing.</p>'
      : `<ul>${items.processes.map((p) => `<li>process ${esc(p)}</li>`).join("")}${items.containers.map((c) => `<li>container ${esc(c)}</li>`).join("")}</ul>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(session.ticket)} ${esc(tool)} exploratory session ${esc(session.id)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:24px;color:#1f2328}
table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top;font-size:12px}
.muted{color:#57606a}tr.bad td{background:#ffebe9}.note{background:#fff8c5;border:1px solid #d4a72c;padding:8px 12px}
.tag{background:#eaeef2;border-radius:10px;padding:1px 8px;font-size:12px}.obs{border-top:1px solid #d0d7de;margin-top:16px}
.obs.high .sev{background:#ffebe9}.obs.medium .sev{background:#fff8c5}:target{outline:3px solid #0969da}
</style></head><body>
<h1>${esc(session.ticket)} · exploratory session ${esc(session.id)} of <code>${esc(tool)}</code></h1>
<p><b>Goal:</b> ${esc(session.goal)}</p>
<p class="muted">Run ${esc(session.run)} · command <code>${esc(session.tool.command.join(" "))}</code> · model ${esc(session.model)}<br>
${esc(session.startedAt)} – ${esc(session.endedAt)} · ended because ${esc(END_REASON[session.endReason])}${session.error ? `: ${esc(session.error)}` : ""} · ${String(session.actions.length)} of ${String(session.budget.steps)} actions, ${String(session.budget.minutes)} min time box</p>
<p class="note">Observations are proposals from an agent for a person to assess. They are not test results.</p>
${renderClaimsHtml(session)}
<h2>Observations (${String(session.observations.length)})</h2>
${observations || '<p class="muted">(none)</p>'}
<h2>Actions</h2>
<table><tr><th>Action</th><th>Time</th><th>Command</th><th>Result</th><th>Duration</th><th>Changed files</th><th>Output</th></tr>
${timeline}
</table>
<h2>Left running at the end</h2>
${list(session.leftovers)}
<h2>Stopped by the clean-up</h2>
${list(session.cleaned)}
${session.refusedHosts.length > 0 ? `<h2>Network refused by the allowlist</h2><ul>${session.refusedHosts.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
</body></html>
`;
}
