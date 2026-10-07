import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import {
  QajitsuError,
  loadApprovedPlan,
  parseEventLines,
  processAlive,
  type Plan,
  type RunEvent,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";
import type { RunPorts } from "./run.js";
import { computeVerdict } from "./verdict.js";

/** One case on the watch page. */
export interface WatchCase {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly state: "waiting" | "running" | "done";
  readonly attempt?: number | undefined;
  /** Step running now, with its action from the plan. */
  readonly step?: { readonly id: string; readonly action: string } | undefined;
  /** Outcome of the last finished attempt: preliminary, not a status. */
  readonly preliminary?: string | undefined;
  /** Computed status, only once the run has finished. */
  readonly status?: string | undefined;
  readonly screenshot: boolean;
}

/** What `qj watch` shows (REQ-OBS-09/AC2). */
export interface WatchProgress {
  readonly ticket: string;
  readonly runId: string;
  /** `stopped`: the run is not running any more and never finished; never shown as passed. */
  readonly state: "not started" | "running" | "finished" | "stopped";
  readonly elapsedMs: number;
  readonly lastEvent?: { readonly at: string; readonly event: string } | undefined;
  /** No event for this long while running: shown as possibly stalled. */
  readonly quietMs: number;
  readonly cases: readonly WatchCase[];
}

/**
 * Computes the progress of a run from its journal (REQ-OBS-09/AC3+AC4). Only the runner's events are read; outcomes
 * are preliminary until the run finished, then the computed statuses are shown. A run that is neither running nor
 * finished is `stopped`.
 *
 * @param input - Plan, journal events, whether the run process is alive, finished statuses and live screenshots.
 */
export function computeWatchProgress(input: {
  readonly ticket: string;
  readonly runId: string;
  readonly plan: Plan;
  readonly events: readonly RunEvent[];
  readonly running: boolean;
  /** Computed statuses by case once the run finished. */
  readonly final?: ReadonlyMap<string, string> | undefined;
  readonly screenshots: ReadonlySet<string>;
  readonly now: number;
}): WatchProgress {
  const run = input.events.filter((e) => e.stage === "run");
  const start = run.find((e) => e.event === "stage.start");
  const finished = input.final !== undefined || run.some((e) => e.event === "stage.end");
  const cases = new Map<
    string,
    { state: WatchCase["state"]; attempt?: number; step?: string | undefined; preliminary?: string }
  >();
  for (const e of run) {
    const d = (e.details ?? {}) as Record<string, unknown>;
    const caseId = typeof d["caseId"] === "string" ? d["caseId"] : undefined;
    if (caseId === undefined) continue;
    const attempt = typeof d["attempt"] === "number" ? d["attempt"] : undefined;
    const current = cases.get(caseId) ?? { state: "waiting" as const };
    if (e.event === "case.attempt.start")
      cases.set(caseId, { ...current, state: "running", ...(attempt ? { attempt } : {}), step: undefined });
    else if (e.event === "step.start" && typeof d["step"] === "string")
      cases.set(caseId, { ...current, state: "running", step: d["step"] });
    else if (e.event === "case.attempt.end")
      cases.set(caseId, { ...current, state: "done", step: undefined, preliminary: String(d["outcome"]) });
    else if (e.event === "case.blocked" || e.event === "case.not_run")
      cases.set(caseId, {
        ...current,
        state: "done",
        preliminary: e.event === "case.blocked" ? "blocked" : "not run",
      });
  }
  const last = input.events.at(-1);
  const lastAt = last ? Date.parse(last.ts) : input.now;
  return {
    ticket: input.ticket,
    runId: input.runId,
    state: finished ? "finished" : input.running ? "running" : start ? "stopped" : "not started",
    elapsedMs: start ? (finished && last ? lastAt : input.now) - Date.parse(start.ts) : 0,
    ...(last ? { lastEvent: { at: last.ts, event: last.event } } : {}),
    quietMs: finished ? 0 : Math.max(0, input.now - lastAt),
    cases: input.plan.cases.map((c) => {
      const s = cases.get(c.id);
      const step = s?.step;
      const status = input.final?.get(c.id);
      return {
        id: c.id,
        title: c.title,
        type: c.type,
        state: finished ? "done" : (s?.state ?? "waiting"),
        ...(s?.attempt ? { attempt: s.attempt } : {}),
        ...(step && !finished
          ? { step: { id: step, action: c.steps.find((x) => x.id === step)?.action ?? "" } }
          : {}),
        ...(s?.preliminary ? { preliminary: s.preliminary } : {}),
        ...(status ? { status } : {}),
        screenshot: input.screenshots.has(c.id),
      };
    }),
  };
}

/** The watch page: no external resources; every text is inserted as text, never as HTML. */
export const WATCH_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>QAJitsu watch</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:0;padding:16px;background:#f6f7f9;color:#1d2330}
h1{font-size:18px;margin:0 0 4px}#meta{color:#555;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.case{background:#fff;border:1px solid #dde1e7;border-radius:8px;padding:10px}
.case.running{border-color:#2f6fde;box-shadow:0 0 0 2px #2f6fde33}
.id{font-weight:600}.muted{color:#666}.tag{display:inline-block;padding:1px 6px;border-radius:4px;background:#eef0f3;margin-left:6px;font-size:12px}
.PASSED{background:#d8f3dc}.FAILED{background:#ffd6d6}.BLOCKED,.NOT_RUN,.FLAKY,.NEEDS_REVIEW{background:#fff1c2}
img{max-width:100%;margin-top:8px;border:1px solid #dde1e7;border-radius:4px}
#banner{padding:8px 10px;border-radius:6px;margin-bottom:12px;background:#fff1c2}
</style></head><body>
<h1 id="title">QAJitsu</h1><div id="meta"></div><div id="banner" hidden></div><div class="grid" id="cases"></div>
<script>
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const clock = (ms) => { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
async function tick() {
  let p;
  try { p = await (await fetch("progress.json", { cache: "no-store" })).json(); } catch { return; }
  document.getElementById("title").textContent = p.ticket + " · run " + p.runId;
  document.getElementById("meta").textContent = p.state + " · " + clock(p.elapsedMs) + (p.lastEvent ? " · last event " + p.lastEvent.event : "");
  const banner = document.getElementById("banner");
  const note = p.state === "stopped" ? "The run stopped before it finished; nothing here is a result." :
    p.state === "running" && p.quietMs > 120000 ? "No event for " + clock(p.quietMs) + "; the run may be stalled." :
    p.state === "finished" ? "Finished: statuses computed by QAJitsu." : p.state === "running" ? "Running: outcomes are preliminary until the run finishes." : "";
  banner.hidden = note === ""; banner.textContent = note;
  const box = document.getElementById("cases"); box.replaceChildren();
  for (const c of p.cases) {
    const card = el("div", "case " + c.state);
    const head = el("div"); head.append(el("span", "id", c.id), el("span", "tag", c.type));
    if (c.status) head.append(el("span", "tag " + c.status, c.status));
    else if (c.preliminary) head.append(el("span", "tag", c.preliminary + " (preliminary)"));
    card.append(head, el("div", "", c.title));
    card.append(el("div", "muted", c.state === "running" ? (c.step ? "▶ " + c.step.id + ": " + c.step.action : "starting") + (c.attempt > 1 ? " · attempt " + c.attempt : "") : c.state));
    if (c.screenshot) { const img = el("img"); img.alt = "latest screenshot of " + c.id; img.src = "live/" + c.id + ".png?t=" + Date.now(); card.append(img); }
    box.append(card);
  }
  if (p.state !== "finished" && p.state !== "stopped") setTimeout(tick, 1000);
}
tick();
</script></body></html>
`;

const CASE_PNG = /^\/live\/(TC-\d{2,4})\.png$/;

/**
 * Serves the watch page of a run on 127.0.0.1 (REQ-OBS-09/AC2+AC4): `/`, `/progress.json` and `/live/<case>.png`
 * only; nothing else of the run folder.
 */
export async function serveWatch(
  session: RunSession,
  port: number,
  now: () => number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const { ws, masker } = session;
  const { plan } = await loadApprovedPlan(ws);
  let final: Map<string, string> | undefined;
  const progress = async (): Promise<WatchProgress> => {
    const { events } = parseEventLines(
      await readFile(ws.path("journal", "events.jsonl"), "utf8").catch(() => ""),
    );
    const record = JSON.parse(await readFile(ws.path("run.json"), "utf8").catch(() => "{}")) as {
      data?: Record<string, unknown>;
    };
    if (!final && record.data?.["results"] !== undefined) {
      const verdict = await computeVerdict(session, () => new Date(now())).catch(() => undefined);
      if (verdict) final = new Map(verdict.cases.map((c) => [c.caseId, c.status]));
    }
    const holder = Number((await readFile(ws.path("run.lock"), "utf8").catch(() => "")).trim());
    const screenshots = new Set<string>();
    for (const c of plan.cases)
      if (await stat(ws.path("live", `${c.id}.png`)).catch(() => undefined)) screenshots.add(c.id);
    return computeWatchProgress({
      ticket: ws.ticket,
      runId: ws.runId,
      plan,
      events,
      running: Number.isInteger(holder) && holder > 0 && processAlive(holder),
      final,
      screenshots,
      now: now(),
    });
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      const headers = { "x-content-type-options": "nosniff", "cache-control": "no-store" };
      if (req.method !== "GET") {
        res.writeHead(405, headers).end();
        return;
      }
      if (path === "/") {
        res.writeHead(200, {
          ...headers,
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'",
        });
        res.end(WATCH_PAGE);
        return;
      }
      if (path === "/progress.json") {
        res.writeHead(200, { ...headers, "content-type": "application/json" });
        res.end(masker.maskText(JSON.stringify(await progress())));
        return;
      }
      const png = CASE_PNG.exec(path)?.[1];
      const bytes =
        png === undefined ? undefined : await readFile(ws.path("live", `${png}.png`)).catch(() => undefined);
      if (bytes === undefined) {
        res.writeHead(404, { ...headers, "content-type": "text/plain" }).end("not found\n");
        return;
      }
      res.writeHead(200, { ...headers, "content-type": "image/png" }).end(bytes);
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${String(actual)}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * `qajitsu watch <TICKET>`: a local page with the progress of a run while it runs (REQ-OBS-09/AC2): cases, the step
 * running now, the latest screenshot of web and mobile cases, preliminary outcomes, and the computed statuses once
 * the run finished. Runs until Ctrl+C.
 *
 * @returns 0 after Ctrl+C, 3 on errors.
 */
export async function runWatch(
  rawKey: string,
  options: { readonly run?: string | undefined; readonly port?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & RunPorts,
): Promise<number> {
  const masker = createMasker();
  const signals = ports.signals ?? process;
  let stop: () => void = () => undefined;
  const onSignal = (): void => {
    stop();
  };
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const port = options.port === undefined ? 0 : Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      io.writeError("--port must be a port number.\n");
      return 3;
    }
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    signals.on("SIGINT", onSignal);
    signals.on("SIGTERM", onSignal);
    const watch = await serveWatch(session, port, () => ports.now().getTime());
    io.write(`Watching ${session.ws.ticket} run ${session.ws.runId}: ${watch.url}\nPress Ctrl+C to stop.\n`);
    await stopped;
    await watch.close();
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  } finally {
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
  }
}
