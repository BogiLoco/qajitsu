import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CliLeftovers } from "@qajitsu/core";

/** Hosts a sandboxed tool may always reach: its own machine (e.g. an environment it starts). */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Folders a file snapshot does not descend into: large and never what a session changes on purpose. */
const SNAPSHOT_SKIP = new Set(["node_modules", ".git"]);
const SNAPSHOT_LIMIT = 20_000;

/**
 * A local HTTP proxy that lets a sandboxed tool reach only loopback and the origins of its allowlist
 * (REQ-EXEC-24/AC2). Plain requests are forwarded, `CONNECT` tunnels opened, anything else answered with 403 and
 * reported. A tool that ignores the proxy variables is not stopped by it; the report says which hosts were refused.
 *
 * @param allowlist - Origins the tool may reach.
 * @param onRefused - Called with `host:port` of every refused request.
 */
export async function startAllowlistProxy(
  allowlist: readonly string[],
  onRefused: (hostPort: string) => void,
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const origins = allowlist.map((a) => new URL(a));
  const allowed = (host: string, port: number): boolean =>
    LOOPBACK.has(host) ||
    origins.some(
      (o) => o.hostname === host && Number(o.port || (o.protocol === "https:" ? 443 : 80)) === port,
    );
  const server = http.createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("absolute URL expected");
      return;
    }
    const port = Number(target.port || 80);
    if (target.protocol !== "http:" || !allowed(target.hostname, port)) {
      onRefused(`${target.hostname}:${String(port)}`);
      res.writeHead(403).end("refused by the QAJitsu allowlist\n");
      return;
    }
    const upstream = http.request(
      {
        host: target.hostname,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: req.headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  const tunnels = new Set<net.Socket>();
  server.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
    const [host = "", rawPort = "443"] = (req.url ?? "").split(/:(?=\d+$)/);
    const port = Number(rawPort);
    if (!allowed(host, port)) {
      onRefused(`${host}:${String(port)}`);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    // Open CONNECT tunnels are not HTTP connections closeAllConnections() knows about: they are destroyed here, and
    // the close never waits longer than two seconds.
    close: () =>
      Promise.race([
        new Promise<void>((done) => {
          for (const socket of tunnels) socket.destroy();
          server.closeAllConnections();
          server.close(() => {
            done();
          });
        }),
        new Promise<void>((done) => {
          setTimeout(done, 2000).unref();
        }),
      ]),
  };
}

/** Relative paths starting with `./` or `../` are taken from `base`; anything else stays as written. */
export const fromBase = (base: string, part: string): string =>
  part.startsWith("./") || part.startsWith("../") ? resolve(base, part) : part;

/** A throwaway folder for one session (REQ-EXEC-24/AC1): `work/` (the fixture copy), `home/` and `tmp/`. */
export interface CliSandbox {
  readonly root: string;
  readonly work: string;
  readonly home: string;
  readonly tmp: string;
  /** The root and its resolved form (macOS `/var` is `/private/var`), to recognise the sandbox in command lines. */
  readonly markers: readonly string[];
}

/**
 * Creates the sandbox: the fixture folder copied into `work/` (without `node_modules` and `.git`), an empty `home/`
 * and `tmp/`.
 *
 * @param fixture - Folder to copy, or undefined for an empty `work/`.
 */
export async function createSandbox(fixture: string | undefined): Promise<CliSandbox> {
  const root = await mkdtemp(join(tmpdir(), "qj-sandbox-"));
  const work = join(root, "work");
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  if (fixture)
    await cp(fixture, work, {
      recursive: true,
      filter: (source) => !source.split(sep).some((p) => SNAPSHOT_SKIP.has(p)),
    });
  else await mkdir(work, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(tmp, { recursive: true });
  const real = await realpath(root);
  return { root, work, home, tmp, markers: [...new Set([root, real])] };
}

/**
 * The environment of a sandboxed tool (REQ-EXEC-24/AC2): PATH, LANG and TERM of the person, the sandbox's HOME and
 * TMPDIR, the proxy, and the configured variables; nothing else (no tokens, no cloud credentials, no SSH agent).
 */
export function sandboxEnv(
  sandbox: CliSandbox,
  proxy: string,
  configured: Readonly<Record<string, string>>,
  host: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const keep = (name: string): Record<string, string> =>
    host[name] === undefined ? {} : { [name]: host[name] };
  return {
    ...keep("PATH"),
    ...keep("LANG"),
    ...keep("SYSTEMROOT"),
    TERM: "dumb",
    NO_COLOR: "1",
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    TMPDIR: sandbox.tmp,
    TMP: sandbox.tmp,
    TEMP: sandbox.tmp,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    ALL_PROXY: proxy,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    NODE_USE_ENV_PROXY: "1",
    ...configured,
  };
}

/** Result of a finished command. */
export interface CommandEnd {
  readonly exitCode?: number | undefined;
  readonly endedBy?: string | undefined;
  readonly timedOut: boolean;
}

/** A command of the session: its output so far and how it ends. */
export interface RunningCommand {
  readonly pid: number | undefined;
  readonly args: readonly string[];
  /** Output since the last call (stdout and stderr in order of arrival). */
  readonly takeOutput: () => string;
  /** All output so far. */
  readonly allOutput: () => string;
  readonly send: (line: string) => void;
  readonly signal: (name: "SIGINT" | "SIGTERM") => void;
  /** Resolves when the command ends; `waitMs` limits the wait (undefined: still running). */
  readonly wait: (waitMs: number) => Promise<CommandEnd | undefined>;
  readonly ended: () => CommandEnd | undefined;
  /** Stops the command and everything it started in its process group. */
  readonly kill: () => Promise<void>;
}

const MAX_OUTPUT = 400_000;

/** Sends a signal to a process group, ignoring a group that is already gone. */
const signalGroup = (pid: number | undefined, sig: NodeJS.Signals): void => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      // Already gone.
    }
  }
};

/**
 * Runs the tool's program with an argument array, never a shell, in its own process group, so a signal or the
 * clean-up reaches everything it started (REQ-EXEC-24/AC2+AC3). The per-command timeout stops the group.
 *
 * @param spec - Program, fixed arguments, the session's arguments, folder, environment, timeout and input lines.
 */
export function startCommand(spec: {
  readonly program: string;
  readonly baseArgs: readonly string[];
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly input?: readonly string[] | undefined;
  /** Keep standard input open for `send` (background commands). */
  readonly interactive?: boolean;
}): RunningCommand {
  let output = "";
  let read = 0;
  let end: CommandEnd | undefined;
  let timedOut = false;
  let child: ChildProcess;
  const append = (chunk: Buffer | string): void => {
    if (output.length < MAX_OUTPUT) output += chunk.toString();
  };
  try {
    child = spawn(spec.program, [...spec.baseArgs, ...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    append(`${error instanceof Error ? error.message : String(error)}\n`);
    end = { exitCode: 127, timedOut: false };
    child = undefined as unknown as ChildProcess;
  }
  const ended = new Promise<CommandEnd>((done) => {
    if (end) {
      done(end);
      return;
    }
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (e) => {
      append(`${e.message}\n`);
    });
    child.on("close", (code, sig) => {
      end = {
        ...(code !== null ? { exitCode: code } : {}),
        ...(sig ? { endedBy: sig } : {}),
        timedOut,
      };
      done(end);
    });
  });
  const timer = setTimeout(() => {
    if (end) return;
    timedOut = true;
    signalGroup(child.pid, "SIGTERM");
    setTimeout(() => {
      signalGroup(child.pid, "SIGKILL");
    }, 3000).unref();
  }, spec.timeoutMs);
  timer.unref();
  void ended.then(() => {
    clearTimeout(timer);
  });
  if (!end) {
    for (const line of spec.input ?? []) child.stdin?.write(`${line}\n`);
    if (spec.interactive !== true) child.stdin?.end();
    child.stdin?.on("error", () => undefined);
  }
  return {
    pid: end ? undefined : child.pid,
    args: spec.args,
    takeOutput: () => {
      const next = output.slice(read);
      read = output.length;
      return next;
    },
    allOutput: () => output,
    send: (line) => {
      if (!end) child.stdin?.write(`${line}\n`);
    },
    signal: (name) => {
      if (!end) signalGroup(child.pid, name);
    },
    wait: (waitMs) =>
      Promise.race([
        ended,
        new Promise<undefined>((done) => {
          setTimeout(() => {
            done(undefined);
          }, waitMs).unref();
        }),
      ]),
    ended: () => end,
    kill: async () => {
      if (end) return;
      signalGroup(child.pid, "SIGTERM");
      if (await Promise.race([ended, new Promise((d) => setTimeout(d, 3000))])) return;
      signalGroup(child.pid, "SIGKILL");
      await Promise.race([ended, new Promise((d) => setTimeout(d, 2000))]);
    },
  };
}

/** Files of a folder tree with size and modification time, to see what an action changed. */
export async function snapshotFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    if (files.size >= SNAPSHOT_LIMIT) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (files.size >= SNAPSHOT_LIMIT) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SNAPSHOT_SKIP.has(entry.name)) await walk(path);
      } else {
        const st = await lstat(path).catch(() => undefined);
        if (st) files.set(relative(root, path), `${String(st.size)}:${String(st.mtimeMs)}`);
      }
    }
  };
  await walk(root);
  return files;
}

/** Paths added (`+`), changed (`~`) or removed (`-`) between two snapshots. */
export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [path, stamp] of after)
    if (!before.has(path)) out.push(`+ ${path}`);
    else if (before.get(path) !== stamp) out.push(`~ ${path}`);
  for (const path of before.keys()) if (!after.has(path)) out.push(`- ${path}`);
  return out.sort((a, b) => a.slice(2).localeCompare(b.slice(2))).slice(0, 200);
}

/**
 * A path the tool's session may read: inside the sandbox after resolving links; undefined otherwise.
 *
 * @param sandbox - The session's sandbox.
 * @param path - Path from the agent, relative to `work/` or absolute.
 */
export async function insideSandbox(sandbox: CliSandbox, path: string): Promise<string | undefined> {
  const wanted = isAbsolute(path) ? path : join(sandbox.work, path);
  const real = await realpath(wanted).catch(() => undefined);
  if (real === undefined) return undefined;
  const roots = await Promise.all(sandbox.markers.map((m) => realpath(m).catch(() => m)));
  return roots.some((r) => real === r || real.startsWith(`${r}${sep}`)) ? real : undefined;
}

/** Output of a helper program, or undefined when it cannot run (no Docker, no ps). */
export type ToolProbe = (program: string, args: readonly string[]) => Promise<string | undefined>;

const probe: ToolProbe = (program, args) =>
  new Promise((done) => {
    // SIGKILL: a hung Docker client may ignore SIGTERM, and the session must never wait for it.
    execFile(
      program,
      [...args],
      { timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 },
      (e, out) => {
        done(e ? undefined : out);
      },
    );
  });

/**
 * What the session left running (REQ-EXEC-24/AC3+AC5): its background commands that still run, processes whose
 * command line names the sandbox, and containers whose labels or mounts name it (e.g. Compose projects built from a
 * worktree inside the sandbox).
 */
export async function findLeftovers(
  sandbox: CliSandbox,
  running: readonly { readonly id: string; readonly command: RunningCommand }[],
  run: ToolProbe = probe,
): Promise<CliLeftovers & { readonly pids: readonly number[]; readonly containerIds: readonly string[] }> {
  const processes: string[] = running
    .filter((r) => r.command.ended() === undefined)
    .map((r) => `${r.id} (pid ${String(r.command.pid)}): ${r.command.args.join(" ")}`);
  const pids: number[] = [];
  const own = process.pid;
  const ps = (await run("ps", ["-axo", "pid=,command="])) ?? "";
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = m[2] ?? "";
    if (pid === own || !sandbox.markers.some((s) => command.includes(s))) continue;
    if (command.startsWith("ps ")) continue;
    pids.push(pid);
    processes.push(`pid ${String(pid)}: ${command.slice(0, 300)}`);
  }
  // Ports the left processes listen on, e.g. an environment a command started and never stopped.
  const tracked = running.flatMap((r) =>
    r.command.ended() === undefined && r.command.pid ? [r.command.pid] : [],
  );
  const all = [...new Set([...pids, ...tracked])];
  if (all.length > 0) {
    const lsof = (await run("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", all.join(",")])) ?? "";
    const ports = new Map<number, string[]>();
    for (const line of lsof.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      const pid = Number(cols[1]);
      const port = /:(\d+)$/.exec(cols[8] ?? "")?.[1];
      if (port) ports.set(pid, [...(ports.get(pid) ?? []), port]);
    }
    for (const [pid, list] of ports)
      processes.push(`pid ${String(pid)} listens on port ${[...new Set(list)].join(", ")}`);
  }
  const containers: string[] = [];
  const containerIds: string[] = [];
  const docker = await run("docker", ["ps", "--format", "{{.ID}}\t{{.Names}}\t{{.Labels}}\t{{.Mounts}}"]);
  for (const line of (docker ?? "").split("\n")) {
    const [id = "", name = "", ...rest] = line.split("\t");
    if (id === "" || !sandbox.markers.some((s) => rest.join("\t").includes(s))) continue;
    containerIds.push(id);
    containers.push(`${name} (${id})`);
  }
  return { processes: [...new Set(processes)], containers, pids, containerIds };
}

/**
 * Stops everything the session left (REQ-EXEC-24/AC5): background commands and their process groups, processes
 * naming the sandbox, and containers labelled with it; returns what was stopped.
 */
export async function cleanUpLeftovers(
  sandbox: CliSandbox,
  running: readonly { readonly id: string; readonly command: RunningCommand }[],
  run: ToolProbe = probe,
): Promise<CliLeftovers> {
  const found = await findLeftovers(sandbox, running, run);
  for (const r of running) await r.command.kill();
  for (const pid of found.pids) signalGroup(pid, "SIGTERM");
  if (found.pids.length > 0) await new Promise((d) => setTimeout(d, 1000));
  for (const pid of found.pids) signalGroup(pid, "SIGKILL");
  if (found.containerIds.length > 0) await run("docker", ["rm", "-f", ...found.containerIds]);
  return { processes: found.processes, containers: found.containers };
}

/** Reads a file of the sandbox for the agent, at most `limit` characters. */
export async function readSandboxFile(path: string, limit = 20_000): Promise<string> {
  const text = await readFile(path, "utf8");
  return text.length > limit
    ? `${text.slice(0, limit)}\n… (${String(text.length - limit)} more characters)`
    : text;
}

/** Removes the sandbox. */
export async function removeSandbox(sandbox: CliSandbox): Promise<void> {
  await rm(sandbox.root, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Whether an argument names a path outside the sandbox (REQ-EXEC-24/AC2): absolute paths, `~`, Windows drives and
 * `..` that leads out of the working folder, also as the value of `--option=value`. URLs are not paths. The tool's
 * own behaviour is not limited by this; its HOME, TMPDIR and working folder are the sandbox.
 *
 * @param sandbox - The session's sandbox.
 * @param arg - One argument the agent asked for.
 */
export function argOutsideSandbox(sandbox: CliSandbox, arg: string): boolean {
  const values = [arg, ...(arg.includes("=") ? [arg.slice(arg.indexOf("=") + 1)] : [])];
  const inside = (path: string): boolean =>
    sandbox.markers.some((m) => path === m || path.startsWith(`${m}${sep}`));
  return values.some((value) => {
    if (value.includes("://")) return false;
    if (/^~(?:[/\\]|$)/.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return true;
    if (isAbsolute(value)) return !inside(resolve(value));
    if (!/(^|[/\\])\.\.([/\\]|$)/.test(value)) return false;
    return !inside(resolve(sandbox.work, value));
  });
}
