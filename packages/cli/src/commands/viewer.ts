import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, sep } from "node:path";
import { QajitsuError } from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts } from "../session.js";
import type { CommandIO } from "./fetch.js";
import type { RunPorts } from "./run.js";

/** Folders of a run the viewer serves; `env/` (generated .env files), `repos/` and the journal never are. */
const SERVED = ["report", "evidence"] as const;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".har": "application/json",
  ".log": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
};

/**
 * Serves the report and evidence of one run on localhost (REQ-PRJ-10/AC4): only `report/` and `evidence/`, only
 * regular files whose real path stays inside them (no `..`, no symlinks out), bound to 127.0.0.1.
 *
 * @param runDir - The run workspace.
 * @param port - Port to listen on; 0 picks a free one.
 */
export async function serveRun(
  runDir: string,
  port = 0,
): Promise<{ url: string; close: () => Promise<void> }> {
  const roots = await Promise.all(
    SERVED.map((d) =>
      realpath(join(runDir, d)).then(
        (p) => p,
        () => undefined,
      ),
    ),
  );
  const server: Server = createServer((req, res) => {
    void (async () => {
      const notFound = (): void => {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found\n");
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        notFound();
        return;
      }
      const path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
      if (path === "/") {
        res.writeHead(302, { location: "/report/report.html" });
        res.end();
        return;
      }
      const [, top = "", ...rest] = path.split("/");
      const index = SERVED.indexOf(top as (typeof SERVED)[number]);
      const root = roots[index];
      if (index < 0 || root === undefined || rest.length === 0 || rest.some((s) => s === ".." || s === "")) {
        notFound();
        return;
      }
      const real = await realpath(join(root, ...rest)).catch(() => undefined);
      if (!real?.startsWith(`${root}${sep}`)) {
        notFound();
        return;
      }
      const info = await stat(real).catch(() => undefined);
      if (!info?.isFile()) {
        notFound();
        return;
      }
      res.writeHead(200, {
        "content-type": TYPES[extname(real).toLowerCase()] ?? "application/octet-stream",
        "content-length": String(info.size),
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      if (req.method === "HEAD") return void res.end();
      createReadStream(real).pipe(res);
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${String(address.port)}/`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * `qajitsu evidence <TICKET> --serve [--port <n>]`: the local viewer of a run's report, screenshots and videos
 * (REQ-PRJ-10/AC4). It serves the run of the resolved project only, on 127.0.0.1, until Ctrl+C.
 *
 * @returns 0 after Ctrl+C, 3 on errors.
 */
export async function runEvidenceServe(
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
    const viewer = await serveRun(session.ws.dir, port);
    io.write(
      `Report of ${session.ws.ticket} run ${session.ws.runId}: ${viewer.url}\nPress Ctrl+C to stop.\n`,
    );
    await stopped;
    await viewer.close();
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
