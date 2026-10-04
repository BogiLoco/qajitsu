import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { apiService, createBuildProject } from "../../../../tests/support/cli-build.js";
import { blockedReason, renderPrometheus } from "./metrics.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("metrics (REQ-OBS-04)", () => {
  it("REQ-OBS-04/AC1: runs, statuses per environment, BLOCKED reasons, duration, tokens, cost, plan acceptance, denials", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    await p.prepare();
    expect((await p.run(["run", "DEMO-1", "--build"])).exitCode).toBe(0);
    // A second run that cannot start: BLOCKED with a reason category.
    const broken = await createBuildProject(apiService('["node", "-e", "process.exit(1)"]'));
    cleanups.push(broken.cleanup);
    await broken.prepare();
    await broken.run(["run", "DEMO-1", "--build"]);
    const text = (await p.run(["metrics"])).out;
    expect(text).toContain("# TYPE qajitsu_runs gauge");
    expect(text).toContain('qajitsu_runs{status="completed"} 1');
    expect(text).toContain('qajitsu_cases{status="PASSED",environment="build (local)"} 2');
    expect(text).toMatch(/qajitsu_tokens\{ticket="DEMO-1"\} \d+/);
    expect(text).toContain("qajitsu_plan_accepted_unchanged_ratio 1");
    expect(text).toContain("qajitsu_false_failed_ratio 0");
    const blocked = (await broken.run(["metrics", "--format", "json"])).out;
    expect(JSON.parse(blocked)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "qajitsu_blocked",
          labels: { reason: "env_start_failed", environment: "build (local)" },
          value: 2,
        }),
      ]),
    );
    const out = join(p.project, "qajitsu.prom");
    expect((await p.run(["metrics", "--out", "qajitsu.prom"])).out).toContain("Wrote");
    expect(await readFile(out, "utf8")).toContain("qajitsu_runs");
  }, 180_000);

  it("REQ-OBS-04/AC2: example alert rules cover stuck runs, cost spikes, BLOCKED series and denied access", async () => {
    const rules = parse(
      await readFile(new URL("../../../../docs/ops/prometheus-alerts.yml", import.meta.url), "utf8"),
    ) as {
      groups: { rules: { alert: string; expr: string }[] }[];
    };
    const alerts = rules.groups.flatMap((g) => g.rules);
    expect(alerts.map((a) => a.alert)).toEqual(
      expect.arrayContaining([
        "QajitsuRunStuck",
        "QajitsuCostSpike",
        "QajitsuBlockedSeries",
        "QajitsuAccessDenied",
      ]),
    );
    // Every metric an alert uses is one QAJitsu emits.
    const emitted = [
      "qajitsu_run_running_seconds",
      "qajitsu_cost_usd",
      "qajitsu_blocked",
      "qajitsu_guard_denied",
      "qajitsu_false_failed_ratio",
    ];
    for (const a of alerts) expect(emitted.some((m) => a.expr.includes(m))).toBe(true);
  });

  it("groups BLOCKED reasons and escapes Prometheus labels", () => {
    expect(
      [
        "environment did not start: x",
        "environment not healthy: y",
        "mobile device not available: z",
        "spec failed static checks",
        "author could not produce",
        "Token budget exceeded",
        "request timed out",
        "?",
        undefined,
      ].map(blockedReason),
    ).toEqual([
      "env_start_failed",
      "env_unhealthy",
      "device_unavailable",
      "spec_rejected",
      "author_failed",
      "token_budget",
      "timeout",
      "other",
      "other",
    ]);
    expect(
      renderPrometheus([{ name: "m", help: "h", type: "gauge", labels: { t: 'a"b\\c\nd' }, value: 1 }]),
    ).toBe('# HELP m h\n# TYPE m gauge\nm{t="a\\"b\\\\c\\nd"} 1\n');
  });
});
