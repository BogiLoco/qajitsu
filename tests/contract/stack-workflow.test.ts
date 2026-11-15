// The stack is started for real in CI (REQ-GEN-10/AC6): Docker on every pull request, Podman every night.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
}
interface Job {
  readonly if?: string;
  readonly services?: Record<string, { readonly image?: string }>;
  readonly steps: readonly Step[];
}
const ci = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")) as {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
};

describe("the stack in CI (REQ-GEN-10/AC6)", () => {
  it("REQ-GEN-10/AC6: Docker runs the stack smoke test on every pull request, Podman every night and on demand", () => {
    const docker = ci.jobs["stack-docker"];
    const podman = ci.jobs["stack-podman"];
    expect(docker?.if).toBeUndefined();
    expect(podman?.if).toBe("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
    expect(Object.keys(ci.on)).toEqual(
      expect.arrayContaining(["pull_request", "schedule", "workflow_dispatch"]),
    );
    expect(docker?.steps.at(-1)?.run).toBe('node scripts/stack-smoke.mjs docker "$IMAGE"');
    expect(podman?.steps.at(-1)?.run).toBe('node scripts/stack-smoke.mjs podman "$IMAGE"');
  });

  it("REQ-GEN-10/AC4+AC6: the image under test is this change's, pushed to a local registry so it has a digest", () => {
    for (const name of ["stack-docker", "stack-podman"]) {
      const job = ci.jobs[name];
      expect(job?.services?.["registry"]?.image, name).toMatch(/^registry:[\d.]+@sha256:[0-9a-f]{64}$/);
      const runs = (job?.steps ?? []).map((s) => s.run ?? "").join("\n");
      expect(runs, name).toContain("pnpm build");
      expect(runs, name).toContain('node scripts/image-context.mjs "$RUNNER_TEMP/image"');
      expect(runs, name).toMatch(/(docker|podman) build -f ci\/docker\/Dockerfile\.release/);
      expect(runs, name).toContain("localhost:5000/qajitsu:ci");
      // No credentials: nothing leaves the job, and the checkout keeps no token.
      expect(JSON.stringify(job), name).not.toContain("secrets.");
      expect(
        job?.steps.find((s) => s.uses?.startsWith("actions/checkout@"))?.with?.["persist-credentials"],
        name,
      ).toBe(false);
      for (const step of job?.steps ?? [])
        if (step.uses !== undefined) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
    }
  });
});
