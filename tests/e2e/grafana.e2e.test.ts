// REQ-OBS-03/AC2 + REQ-OBS-04/AC3: a run exported over OTLP shows up in the local Grafana stack (ops/grafana):
// metrics in Prometheus, journal logs in Loki, the run trace in Tempo, and the dashboard is provisioned.
// Skipped unless the stack is up (`docker compose -f ops/grafana/docker-compose.yml up -d`).
import { afterAll, describe, expect, it } from "vitest";
import { apiService, createBuildProject } from "../support/cli-build.js";

const up = await fetch("http://127.0.0.1:3000/api/health").then(
  (r) => r.ok,
  () => false,
);
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const poll = async <T>(read: () => Promise<T | undefined>, ms = 60_000): Promise<T | undefined> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read().catch(() => undefined);
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return undefined;
};

describe.skipIf(!up)("Grafana stack (REQ-OBS-04/AC3)", () => {
  it("REQ-OBS-03/AC2 + REQ-OBS-04/AC3: metrics, logs and the run trace reach Prometheus, Loki and Tempo; the dashboard is there", async () => {
    const p = await createBuildProject(
      `${apiService()}\ntelemetry: { otlp: { endpoint: "http://127.0.0.1:4318" } }`,
    );
    cleanups.push(p.cleanup);
    await p.prepare();
    const result = await p.run(["run", "DEMO-1", "--build", "--set", "api.BUG_CART_TOTAL_ROUNDING=1"]);
    expect(result.err).not.toContain("Telemetry export failed");
    const failed = await poll(async () => {
      const r = (await (
        await fetch(
          "http://127.0.0.1:9090/api/v1/query?query=" +
            encodeURIComponent('qajitsu_cases{qajitsu_status="FAILED"}'),
        )
      ).json()) as {
        data: { result: { value: [number, string] }[] };
      };
      return r.data.result.length > 0 ? r.data.result : undefined;
    });
    expect(failed?.[0]?.value[1]).toBe("1");
    const logs = await poll(async () => {
      const q = new URLSearchParams({
        query: '{service_name="qajitsu"}',
        limit: "50",
        start: String((Date.now() - 3_600_000) * 1e6),
      });
      const r = (await (
        await fetch(
          `http://127.0.0.1:3000/api/datasources/proxy/uid/loki/loki/api/v1/query_range?${q.toString()}`,
        )
      ).json()) as {
        data?: { result?: unknown[] };
      };
      return (r.data?.result?.length ?? 0) > 0 ? r.data?.result : undefined;
    });
    expect(logs).toBeDefined();
    const traces = await poll(async () => {
      const r = (await (
        await fetch(
          `http://127.0.0.1:3000/api/datasources/proxy/uid/tempo/api/search?tags=${encodeURIComponent("service.name=qajitsu")}&limit=20`,
        )
      ).json()) as {
        traces?: { rootTraceName?: string }[];
      };
      return r.traces?.some((t) => t.rootTraceName === "qajitsu DEMO-1") ? r.traces : undefined;
    });
    expect(traces).toBeDefined();
    const dashboards = (await (await fetch("http://127.0.0.1:3000/api/search?query=QAJitsu")).json()) as {
      title: string;
    }[];
    expect(dashboards.map((d) => d.title)).toContain("QAJitsu overview");
  }, 240_000);
});
