import { untrusted, type AgentTool } from "@qajitsu/agents";
import {
  ObservationSchema,
  type EventLog,
  type EvidenceStore,
  type ExploreAction,
  type Observation,
} from "@qajitsu/core";
import { assertSelector, type UiDriver } from "@qajitsu/steps";
import { z } from "zod";

const ORCHESTRATOR = { kind: "system", name: "orchestrator" } as const;
const MAX_TEXT = 3000;
const MAX_ELEMENTS = 80;

/** What the exploration tools record; read by the command when the session ends. */
export interface ExploreRecorder {
  readonly tools: readonly AgentTool[];
  readonly actions: readonly ExploreAction[];
  readonly observations: readonly Observation[];
  /** True once the explorer asked for an action beyond the step budget (REQ-EXEC-15/AC5). */
  readonly exhausted: () => boolean;
}

const unescape = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * Lists the interactive elements of a page with selectors the explorer can use, computed by code from the DOM:
 * `testid:` for elements with `data-testid`, otherwise `role:button:<name>` and `role:link:<name>`.
 *
 * @param html - Serialized DOM of the page.
 */
export function pageElements(html: string): string[] {
  const out: string[] = [];
  const tag = /<(a|button|input|select|textarea|[a-z][\w-]*)\b([^>]*)>([^<]{0,80})/gi;
  for (const m of html.matchAll(tag)) {
    const [, name = "", attrs = "", text = ""] = m;
    const lower = name.toLowerCase();
    const testid = /\bdata-testid=["']([^"']+)["']/.exec(attrs)?.[1];
    const label = unescape(text).trim().replace(/\s+/g, " ");
    const type = /\btype=["']([^"']+)["']/.exec(attrs)?.[1];
    const disabled = /\bdisabled\b/.test(attrs) ? " disabled" : "";
    const kind = lower === "input" ? `input${type ? `[${type}]` : ""}` : lower;
    if (testid) out.push(`testid:${testid} (${kind}${disabled}${label ? ` "${label}"` : ""})`);
    else if ((lower === "button" || lower === "a") && label)
      out.push(`role:${lower === "a" ? "link" : "button"}:${label}${disabled}`);
    if (out.length >= MAX_ELEMENTS) break;
  }
  return out;
}

/**
 * Builds the explorer's tools (REQ-EXEC-15). Each browser action is performed by the trusted parent, which then
 * writes a screenshot into the session's evidence store (manifest with SHA-256) and journals the action before the
 * model sees the result (REQ-EXEC-15/AC2, invariants 2 and 7). Navigation is limited to paths of the environment
 * (invariant 10). Observations must cite actions of this session (REQ-EXEC-15/AC3). The step budget is counted
 * here, in code (REQ-EXEC-15/AC5).
 *
 * @param ctx - Browser, evidence store, masking, journal, budget, account aliases and clock.
 */
export function createExploreTools(ctx: {
  readonly driver: UiDriver;
  readonly store: EvidenceStore;
  readonly mask: (text: string) => string;
  readonly events: EventLog;
  readonly maxSteps: number;
  readonly accounts: readonly string[];
  readonly now: () => Date;
}): ExploreRecorder {
  const actions: ExploreAction[] = [];
  const observations: Observation[] = [];
  let exhausted = false;
  const path = (): string => {
    const url = ctx.driver.url();
    try {
      const u = new URL(url);
      return u.protocol === "about:" ? url : `${u.pathname}${u.search}`;
    } catch {
      return url;
    }
  };
  const refuse = (tool: string, reason: string): string => {
    ctx.events.emit("explore", ORCHESTRATOR, "explore.refused", { tool, reason });
    return `REFUSED: ${reason}`;
  };

  const act = async (
    action: ExploreAction["action"],
    target: string,
    perform: () => Promise<void>,
    value?: string,
  ): Promise<string> => {
    if (actions.length >= ctx.maxSteps) {
      exhausted = true;
      return "STEP BUDGET USED: stop exploring now and answer with the JSON summary.";
    }
    const id = `A${String(actions.length + 1).padStart(2, "0")}`;
    let error: string | undefined;
    try {
      await perform();
    } catch (e) {
      error = ctx.mask((e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "").slice(0, 300);
    }
    let screenshot: string | undefined;
    try {
      const stored = await ctx.store.put(
        { path: `${id}.png`, caseId: "explore", stepId: id, kind: "screenshot" },
        await ctx.driver.screenshot(false),
      );
      screenshot = stored.path;
    } catch {
      // A page that cannot be captured still keeps its action in the timeline.
    }
    const record: ExploreAction = {
      id,
      action,
      target: ctx.mask(target).slice(0, 400),
      ...(value !== undefined ? { value: ctx.mask(value).slice(0, 400) } : {}),
      ok: error === undefined,
      ...(error !== undefined ? { error } : {}),
      url: ctx.mask(ctx.driver.url()).slice(0, 2000),
      ...(screenshot ? { screenshot } : {}),
      at: ctx.now().toISOString(),
    };
    actions.push(record);
    ctx.events.emit("explore", ORCHESTRATOR, "explore.action", {
      id,
      action,
      target: record.target,
      ok: record.ok,
      url: record.url,
    });
    return `${id} ${error === undefined ? "done" : `failed: ${error}`}. Page: ${path()}`;
  };
  const selectorOf = (raw: unknown): string => assertSelector(String(raw));

  const tools: AgentTool[] = [
    {
      name: "explore_look",
      description: "See the current page: its path, visible text and interactive elements with selectors.",
      inputSchema: z.object({}),
      async execute() {
        if (path().startsWith("about:")) return "No page is open yet: use explore_goto with a path, e.g. /.";
        const text = ctx.mask(await ctx.driver.pageText()).slice(0, MAX_TEXT);
        const elements = pageElements(await ctx.driver.dom()).map((e) => ctx.mask(e));
        return `Page: ${path()}\n${untrusted("page", `Visible text:\n${text}\n\nElements:\n${elements.map((e) => `- ${e}`).join("\n")}`)}`;
      },
    },
    {
      name: "explore_goto",
      description: "Open a path of the application under test, e.g. /app/cart (no other sites).",
      inputSchema: z.object({ path: z.string() }),
      execute(input) {
        const target = String(input["path"]);
        if (!/^\/(?![/\\])[^\s]*$/.test(target))
          return Promise.resolve(
            refuse("explore_goto", "explore_goto takes a path of the application, e.g. /app/cart"),
          );
        return act("goto", target, () => ctx.driver.goto(target));
      },
    },
    {
      name: "explore_click",
      description: "Click an element by selector (testid:, role:<role>:<name>, label:, text:, css:).",
      inputSchema: z.object({ selector: z.string() }),
      execute(input) {
        const s = selectorOf(input["selector"]);
        return act("click", s, () => ctx.driver.click(s));
      },
    },
    {
      name: "explore_fill",
      description: "Type a value into a field (never a password: log in with explore_login_as).",
      inputSchema: z.object({ selector: z.string(), value: z.string().max(400) }),
      execute(input) {
        const s = selectorOf(input["selector"]);
        const value = String(input["value"]);
        return act("fill", s, () => ctx.driver.fill(s, value), value);
      },
    },
    {
      name: "explore_select",
      description: "Choose an option of a select element.",
      inputSchema: z.object({ selector: z.string(), value: z.string().max(400) }),
      execute(input) {
        const s = selectorOf(input["selector"]);
        const value = String(input["value"]);
        return act("select", s, () => ctx.driver.select(s, value), value);
      },
    },
    {
      name: "explore_press",
      description: "Press a key in an element, e.g. Enter.",
      inputSchema: z.object({ selector: z.string(), key: z.string().max(40) }),
      execute(input) {
        const s = selectorOf(input["selector"]);
        const key = String(input["key"]);
        return act("press", s, () => ctx.driver.press(s, key), key);
      },
    },
    {
      name: "explore_back",
      description: "Go back in the browser history.",
      inputSchema: z.object({}),
      execute() {
        return act("back", "history", () => ctx.driver.back());
      },
    },
    {
      name: "explore_login_as",
      description: "Log in as an account alias of the environment; QAJitsu performs the login.",
      inputSchema: z.object({ alias: z.string() }),
      execute(input) {
        const alias = String(input["alias"]);
        if (!ctx.accounts.includes(alias))
          return Promise.resolve(
            refuse(
              "explore_login_as",
              `unknown account alias; available: ${ctx.accounts.join(", ") || "(none)"}`,
            ),
          );
        return act("login_as", alias, async () => {
          await ctx.driver.useAccount(alias);
          await ctx.driver.goto(path().startsWith("about:") ? "/" : path());
        });
      },
    },
    {
      name: "record_observation",
      description:
        "Record something a person should look at: title, kind, severity, description, expected, actual and the action ids that reproduce it.",
      inputSchema: z.object({
        title: z.string(),
        kind: z.enum(["possible-bug", "ux", "question", "risk"]),
        severity: z.enum(["low", "medium", "high"]),
        description: z.string(),
        steps: z.array(z.string()),
        expected: z.string().optional(),
        actual: z.string().optional(),
      }),
      execute(input) {
        const steps = (input["steps"] as unknown[]).map(String);
        const known = new Set(actions.map((a) => a.id));
        const unknown = steps.filter((s) => !known.has(s));
        if (steps.length === 0 || unknown.length > 0)
          return Promise.resolve(
            refuse(
              "record_observation",
              `steps must be action ids of this session (unknown: ${unknown.join(", ") || "none given"})`,
            ),
          );
        const parsed = ObservationSchema.safeParse({
          id: `O${String(observations.length + 1)}`,
          title: ctx.mask(String(input["title"])),
          kind: input["kind"],
          severity: input["severity"],
          description: ctx.mask(String(input["description"])),
          steps,
          expected: ctx.mask(typeof input["expected"] === "string" ? input["expected"] : ""),
          actual: ctx.mask(typeof input["actual"] === "string" ? input["actual"] : ""),
        });
        if (!parsed.success)
          return Promise.resolve(
            refuse(
              "record_observation",
              parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
            ),
          );
        observations.push(parsed.data);
        ctx.events.emit("explore", ORCHESTRATOR, "explore.observation", {
          id: parsed.data.id,
          kind: parsed.data.kind,
          severity: parsed.data.severity,
          steps,
        });
        return Promise.resolve(`${parsed.data.id} recorded.`);
      },
    },
  ];
  return { tools, actions, observations, exhausted: () => exhausted };
}
