import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { apiService, createBuildProject } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A fake OTLP/HTTP collector recording what it receives. */
const collector = async (status = 200) => {
  const received: { path: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
  const server: Server = createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      received.push({
        path: req.url ?? "",
        auth: req.headers.authorization,
        body: JSON.parse(data) as Record<string, unknown>,
      });
      res.writeHead(status).end("{}");
    });
  });
  await new Promise<void>((r) =>
    server.listen(0, "127.0.0.1", () => {
      r();
    }),
  );
  cleanups.push(
    () =>
      new Promise((r) =>
        server.close(() => {
          r();
        }),
      ),
  );
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${String(port)}`, received };
};
const spanNames = (body: Record<string, unknown>) =>
  (
    (body["resourceSpans"] as { scopeSpans: { spans: { name: string }[] }[] }[])[0]?.scopeSpans[0]?.spans ??
    []
  ).map((s) => s.name);

describe("OpenTelemetry export from qj (REQ-OBS-03)", () => {
  it("REQ-OBS-03/AC1+AC2: qj run sends traces, logs and metrics over OTLP/HTTP with secret headers; exports are incremental", async () => {
    const c = await collector();
    const p = await createBuildProject(
      `${apiService()}\ntelemetry: { otlp: { endpoint: "${c.url}", headers: { Authorization: "secret://env/DEMO_USER_PASSWORD" } } }`,
    );
    cleanups.push(p.cleanup);
    await p.prepare();
    expect((await p.run(["run", "DEMO-1", "--build"])).exitCode).toBe(0);
    const paths = c.received.map((r) => r.path);
    // approve and run each exported their part of the journal.
    expect(paths.filter((x) => x === "/v1/traces").length).toBe(2);
    expect(paths).toEqual(expect.arrayContaining(["/v1/traces", "/v1/logs", "/v1/metrics"]));
    expect(c.received.every((r) => r.auth === "fictional-demo-password")).toBe(true);
    const runTraces = c.received.filter((r) => r.path === "/v1/traces").at(-1)?.body ?? {};
    expect(spanNames(runTraces)).toEqual(
      expect.arrayContaining(["qajitsu DEMO-1", "stage run", "case TC-01 attempt 1"]),
    );
    expect(spanNames(runTraces)).not.toContain("stage fetch");
    // Nothing new: the manual export sends only the run span again.
    const again = await p.run(["telemetry", "export", "DEMO-1"]);
    expect(again.out).toContain("Exported 0 span(s), 0 log record(s), 0 metric(s).");
  }, 120_000);

  it("REQ-OBS-03: a failing collector never changes the run result", async () => {
    const c = await collector(503);
    const p = await createBuildProject(`${apiService()}\ntelemetry: { otlp: { endpoint: "${c.url}" } }`);
    cleanups.push(p.cleanup);
    await p.prepare();
    const result = await p.run(["run", "DEMO-1", "--build"]);
    expect(result.exitCode).toBe(0);
    expect(result.err).toContain("Telemetry export failed: /v1/traces answered HTTP 503");
    expect((await p.run(["telemetry", "export", "DEMO-1"])).exitCode).toBe(3);
    const none = await createBuildProject();
    cleanups.push(none.cleanup);
    await none.run(["fetch", "DEMO-1"]);
    expect((await none.run(["telemetry", "export", "DEMO-1"])).err).toContain("Telemetry is not configured");
  }, 120_000);
});
