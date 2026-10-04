import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("doctor project checks (REQ-GEN-03/AC2)", () => {
  it("REQ-GEN-03/AC2: secrets by reference only, Jira and code host access online, mobile tooling", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const offline = await p.run(["doctor"]);
    expect(offline.out).toContain("✔ secrets:");
    expect(offline.out).not.toContain("✔ jira");
    const online = await p.run(["doctor", "--online"]);
    expect(online.out).toMatch(/✔ jira: ticket files in .+tickets/);
    expect(online.out).toMatch(/✔ code host local: repositories under/);
    expect(online.exitCode).toBe(0);
    // A secret that cannot be resolved is named by its reference, never by a value.
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      (await readFile(yaml, "utf8")).replace(
        "secret://env/DEMO_USER_PASSWORD",
        "secret://env/NOT_SET_ANYWHERE",
      ) +
        "\nmobile:\n  appium: { bin: ./missing-appium }\n  android: { app: { source: path, repo: shop, path: a.apk }, app_id: a.b, sdk_root: /nonexistent/sdk }\n",
    );
    const broken = await p.run(["doctor"]);
    expect(broken.exitCode).toBe(3);
    expect(broken.out).toContain("✘ secrets: cannot resolve secret://env/NOT_SET_ANYWHERE");
    expect(broken.out).toContain("✘ android: missing /nonexistent/sdk/platform-tools/adb");
    expect(broken.out).toMatch(/✘ appium: .*missing-appium not found/);
  }, 120_000);
});
