import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { RunIdSchema, TicketKeySchema } from "@qajitsu/core";
import {
  consolePlan,
  consoleProjects,
  consoleRun,
  consoleRuns,
  consoleTickets,
  type ConsoleProject,
} from "./data.js";
import { notFoundPage, page, planPage, projectsPage, runPage, runsPage, ticketsPage } from "./pages.js";
import { actionPage, reviewPage } from "./pages-review.js";
import { consolePlanReview } from "./review.js";

/** Folders of a run the console serves files from; the journal, `env/`, `repos/` and `checks/` never are. */
const SERVED = ["report", "evidence"] as const;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".har": "application/json",
  ".log": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv",
  ".xml": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Console pages run no script and load nothing from elsewhere. */
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};
/**
 * Run files (a report, a page the application under test returned) are shown in a sandbox: no script, no access to the
 * console's origin or cookie, and no other page can frame them.
 */
const FILE_POLICY =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; frame-ancestors 'none'";
/** How long a sign-in lasts. */
const SESSION_S = 12 * 3600;
/** The registered projects are read again at most this often. */
const PROJECTS_TTL_MS = 5_000;

/** The run an action is about. */
export interface ActionTarget {
  readonly slug: string;
  readonly ticket: string;
  readonly runId: string;
}

/** What an action did, as the matching CLI command printed it. */
export interface ActionResult {
  readonly ok: boolean;
  readonly output: string;
}

/** What the console's buttons do (REQ-WEB-01/AC3): the same code as the CLI commands, with their rules. */
export interface ConsoleActions {
  readonly approve: (
    target: ActionTarget,
    options: {
      readonly version: number;
      readonly confirmUncovered: boolean;
      readonly confirmPlaceholders: boolean;
      readonly confirmOpenQuestions: boolean;
    },
  ) => Promise<ActionResult>;
  readonly revise: (target: ActionTarget, instruction: string) => Promise<ActionResult>;
  readonly edit: (target: ActionTarget, planYaml: string) => Promise<ActionResult>;
}

/** The largest form an action takes (an edited plan). */
const MAX_FORM_BYTES = 512 * 1024;

/** Where the console is and how to stop it. */
export interface ConsoleServer {
  /** The address to open, with the one-time token that signs the browser in. */
  readonly url: string;
  readonly close: () => Promise<void>;
}

/** Compares two secrets in constant time, whatever their lengths. */
const same = (a: string, b: string): boolean =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/**
 * The local web console (REQ-WEB-01, ADR-0019): projects, tickets, runs, plans, reports and evidence, read from the
 * files the CLI writes; it computes no status of its own (AC2). Only the person who started it gets in (AC4):
 * - it listens on 127.0.0.1 and answers only requests that name that address (no DNS rebinding);
 * - everything lives under a random path, so its cookie is never sent to another server on 127.0.0.1;
 * - the printed address carries a token that signs in one browser once; the session cookie is another random value,
 *   HttpOnly and SameSite=Strict, scoped to that path and named after the port.
 *
 * @param options - The environment and the user's home (to find the QAJitsu home) and the port (0: a free one).
 */
export async function startConsole(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly userHome: string;
  readonly port?: number;
  /** The sign-in token; random by default (tests pass one). */
  readonly token?: string;
  /** What the buttons do (REQ-WEB-01/AC3); without them the console only reads. */
  readonly actions?: ConsoleActions;
}): Promise<ConsoleServer> {
  let signinToken: string | undefined = options.token ?? randomBytes(24).toString("base64url");
  /** Session id → the form token of that session (REQ-WEB-01/AC3: changing actions need it). */
  const sessions = new Map<string, string>();
  const prefix = `/${randomBytes(12).toString("base64url")}`;
  let hosts: readonly string[] = [];
  let cookieName = "qj_console";
  const signedIn = (req: IncomingMessage): boolean => {
    const id = (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    return id !== undefined && [...sessions.keys()].some((s) => same(s, id));
  };
  const csrfOf = (req: IncomingMessage): string | undefined => {
    const id = (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    const found = [...sessions.entries()].find(([s]) => id !== undefined && same(s, id));
    return found?.[1];
  };
  // Every link of a page is written from the root by code; the console's pages live under its random path.
  const send = (res: ServerResponse, status: number, html: string): void => {
    res.writeHead(status, PAGE_HEADERS);
    res.end(html.replaceAll('href="/', `href="${prefix}/`).replaceAll('action="/', `action="${prefix}/`));
  };
  let projects: { readonly at: number; readonly list: Promise<ConsoleProject[]> } | undefined;
  const projectRoot = async (slug: string): Promise<string | undefined> => {
    if (projects === undefined || Date.now() - projects.at > PROJECTS_TTL_MS)
      projects = { at: Date.now(), list: consoleProjects(options.env, options.userHome) };
    return (await projects.list).find((p) => p.slug === slug)?.runsRoot;
  };

  /**
   * Serves one file of a run's `report/` or `evidence/`: the folder must be a real folder inside the run (not a link),
   * the file must resolve inside it, and it is opened without following a link and checked on the handle.
   */
  const serveFile = async (
    res: ServerResponse,
    head: boolean,
    runDir: string,
    rest: readonly string[],
  ): Promise<boolean> => {
    const [top = "", ...inner] = rest;
    if (
      !(SERVED as readonly string[]).includes(top) ||
      inner.length === 0 ||
      inner.some((s) => s === ".." || s === "." || s === "" || s.includes("/") || s.includes("\\"))
    )
      return false;
    const runReal = await realpath(runDir).catch(() => undefined);
    const folder = await lstat(join(runDir, top)).catch(() => undefined);
    if (runReal === undefined || !folder?.isDirectory()) return false;
    const root = await realpath(join(runDir, top)).catch(() => undefined);
    if (!root?.startsWith(`${runReal}${sep}`)) return false;
    const real = await realpath(join(root, ...inner)).catch(() => undefined);
    if (!real?.startsWith(`${root}${sep}`)) return false;
    const handle = await open(
      real,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    ).catch(() => undefined);
    if (!handle) return false;
    const info = await handle.stat().catch(() => undefined);
    if (!info?.isFile()) {
      await handle.close();
      return false;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(real).toLowerCase()] ?? "application/octet-stream",
      "content-length": String(info.size),
      "content-security-policy": FILE_POLICY,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    });
    if (head) {
      await handle.close();
      res.end();
      return true;
    }
    // A file that cannot be read any more ends this answer, never the console.
    await pipeline(handle.createReadStream(), res).catch(() => {
      res.destroy();
    });
    return true;
  };

  const notSignedIn = (res: ServerResponse, text: string): void => {
    send(res, 403, page("Not signed in", [], `<p class="muted">${text}</p>`));
  };

  /**
   * A changing action (REQ-WEB-01/AC3, REQ-WEB-07/AC3): only from the console's own page (its Origin), with the form
   * token of the signed-in session, as a small form; it runs the same code as the matching CLI command.
   */
  const post = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const origin = req.headers.origin ?? "";
    if (!hosts.some((h) => origin === `http://${h}`)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden: not from the console\n");
      return;
    }
    const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim();
    if (type !== "application/x-www-form-urlencoded") {
      res.writeHead(415, { "content-type": "text/plain" });
      res.end("unsupported form\n");
      return;
    }
    // An oversized form is read to its end without being kept, then refused: the browser gets the answer, not a reset.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size <= MAX_FORM_BYTES) chunks.push(chunk);
    }
    if (size > MAX_FORM_BYTES) {
      res.writeHead(413, { "content-type": "text/plain" });
      res.end("form too large\n");
      return;
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const csrf = csrfOf(req);
    if (csrf === undefined || !same(form.get("csrf") ?? "", csrf)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden: the form is not from this session\n");
      return;
    }
    const parts = path
      .split("/")
      .filter((x) => x !== "")
      .map((x) => decodeURIComponent(x));
    const [p, slug = "", t, ticket = "", r, runId = "", action, ...rest] = parts;
    const actions = options.actions;
    if (
      actions === undefined ||
      p !== "p" ||
      t !== "t" ||
      r !== "r" ||
      rest.length > 0 ||
      !TicketKeySchema.safeParse(ticket).success ||
      !RunIdSchema.safeParse(runId).success ||
      (await projectRoot(slug)) === undefined
    ) {
      send(res, 404, notFoundPage("Not found."));
      return;
    }
    const target = { slug, ticket, runId };
    const back = `/p/${encodeURIComponent(slug)}/t/${encodeURIComponent(ticket)}/r/${encodeURIComponent(runId)}/review`;
    let result: ActionResult;
    if (action === "approve") {
      // Exactly the version the reviewer saw, never whatever is newest on disk.
      const version = form.get("version");
      if (version === null || !/^\d{1,4}$/.test(version)) {
        send(res, 400, actionPage("Approve", back, false, "Name the version to approve."));
        return;
      }
      result = await actions.approve(target, {
        version: Number(version),
        confirmUncovered: form.get("confirm_uncovered") === "1",
        confirmPlaceholders: form.get("confirm_placeholders") === "1",
        confirmOpenQuestions: form.get("confirm_open_questions") === "1",
      });
    } else if (action === "revise") {
      const instruction = (form.get("instruction") ?? "").trim();
      if (instruction === "") {
        send(res, 400, actionPage("Revise", back, false, "Say what should change."));
        return;
      }
      result = await actions.revise(target, instruction);
    } else if (action === "edit") {
      result = await actions.edit(target, form.get("plan") ?? "");
    } else {
      send(res, 404, notFoundPage("Not found."));
      return;
    }
    const title = action === "approve" ? "Approve" : action === "revise" ? "Revise" : "Edit";
    send(res, result.ok ? 200 : 422, actionPage(title, back, result.ok, result.output));
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // DNS rebinding: a request must name this address, never another host that resolves to it.
    if (!hosts.includes(req.headers.host ?? "")) {
      res.writeHead(421, { "content-type": "text/plain" });
      res.end("misdirected request\n");
      return;
    }
    const url = new URL(req.url ?? "/", "http://console.invalid");
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204, { "cache-control": "max-age=86400" });
      res.end();
      return;
    }
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      send(res, 404, notFoundPage("Open the address qj console printed."));
      return;
    }
    const path = url.pathname.slice(prefix.length) || "/";
    if (path === "/signin") {
      const given = url.searchParams.get("token") ?? "";
      // The token signs in once: the address in a browser history or a terminal log is worth nothing afterwards.
      if (signinToken === undefined || !same(given, signinToken)) {
        notSignedIn(res, "Start qj console again and open the address it prints.");
        return;
      }
      signinToken = undefined;
      const session = randomBytes(24).toString("base64url");
      sessions.set(session, randomBytes(24).toString("base64url"));
      res.writeHead(303, {
        "set-cookie": `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=${prefix}/; Max-Age=${String(SESSION_S)}`,
        location: `${prefix}/`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end();
      return;
    }
    if (!signedIn(req)) {
      notSignedIn(res, "Open the address qj console printed.");
      return;
    }
    if (req.method === "POST") {
      await post(req, res, path);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD, POST", "content-type": "text/plain" });
      res.end("method not allowed\n");
      return;
    }
    const parts = path
      .split("/")
      .filter((p) => p !== "")
      .map((p) => decodeURIComponent(p));
    if (parts.length === 0) {
      send(res, 200, projectsPage(await consoleProjects(options.env, options.userHome)));
      return;
    }
    const [p, slug = "", t, ticket = "", r, runId = "", kind, ...rest] = parts;
    const root = p === "p" ? await projectRoot(slug) : undefined;
    if (root === undefined) {
      send(res, 404, notFoundPage("No such project."));
      return;
    }
    if (t === undefined) {
      send(res, 200, ticketsPage(slug, await consoleTickets(root)));
      return;
    }
    if (t !== "t" || !TicketKeySchema.safeParse(ticket).success) {
      send(res, 404, notFoundPage("No such ticket."));
      return;
    }
    if (r === undefined) {
      send(res, 200, runsPage(slug, ticket, await consoleRuns(root, ticket)));
      return;
    }
    if (r !== "r" || !RunIdSchema.safeParse(runId).success) {
      send(res, 404, notFoundPage("No such run."));
      return;
    }
    if (kind === undefined) {
      const run = await consoleRun(root, ticket, runId);
      if (run) send(res, 200, runPage(slug, ticket, run));
      else send(res, 404, notFoundPage("No such run."));
      return;
    }
    if (kind === "review" && rest.length === 0) {
      const number = (name: string): number | undefined => {
        const v = url.searchParams.get(name);
        return v !== null && /^\d{1,4}$/.test(v) ? Number(v) : undefined;
      };
      const review = await consolePlanReview(root, ticket, runId, {
        right: number("right"),
        left: number("left"),
      });
      if (!review) {
        send(res, 404, notFoundPage("This run has no plan yet."));
        return;
      }
      const yaml = await readFile(
        join(root, ticket, runId, "plan", `plan.v${String(review.right.version)}.yaml`),
        "utf8",
      ).catch(() => "");
      send(res, 200, reviewPage(slug, ticket, runId, review, csrfOf(req) ?? "", yaml));
      return;
    }
    if (kind === "plan" && rest.length === 1) {
      const version = Number(rest[0]);
      const markdown = await consolePlan(root, ticket, runId, version);
      if (markdown !== undefined) send(res, 200, planPage(slug, ticket, runId, version, markdown));
      else send(res, 404, notFoundPage("No such plan version."));
      return;
    }
    if (kind === "files" && (await serveFile(res, req.method === "HEAD", join(root, ticket, runId), rest)))
      return;
    send(res, 404, notFoundPage("Not found."));
  };

  const server: Server = createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent)
        send(res, 500, page("Error", [], `<p class="muted">The page could not be read.</p>`));
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  hosts = [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`];
  // Two consoles on one machine never overwrite each other's sign-in.
  cookieName = `qj_console_${String(port)}`;
  return {
    url: `http://127.0.0.1:${String(port)}${prefix}/signin?token=${signinToken}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
