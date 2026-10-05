// `pnpm demo` (REQ-NFR-06/AC3): the whole flow on the demo-shop with one command, offline. The clean app passes,
// seeded bug BUG-01 is caught, and nothing is left in the user's run workspace.
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
// The demo-shop profile is allowlisted for http://localhost:3000; the demo needs that port.
const portFree = await new Promise<boolean>((resolve) => {
  const server = createServer()
    .once("error", () => {
      resolve(false);
    })
    .listen(3000, "127.0.0.1", () => {
      server.close(() => {
        resolve(true);
      });
    });
});

describe.skipIf(!portFree)("pnpm demo (REQ-NFR-06/AC3)", () => {
  it("REQ-NFR-06/AC3: runs fetch, plan, approve and run twice; the clean app passes and BUG-01 is caught", async () => {
    const { code, out } = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(
        process.execPath,
        ["scripts/demo.mjs"],
        {
          cwd: root,
          env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
          timeout: 240_000,
        },
        (error, stdout, stderr) => {
          resolve({ code: error ? Number(error.code ?? 1) : 0, out: `${stdout}${stderr}` });
        },
      );
    });
    expect(out).toContain("offline: the agents' answers are recorded");
    expect(out).toContain('clean app:   {"TC-01":"PASSED","TC-02":"PASSED"}');
    expect(out).toContain('with BUG-01: {"TC-01":"FAILED","TC-02":"PASSED"}');
    expect(out).not.toMatch(/Warning|Auditor did not complete|Demo failed/);
    expect(code).toBe(0);
  }, 300_000);
});
