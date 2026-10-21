import { describe, expect, it } from "vitest";
import { formatDoctor, reportedBy, secretFileCheck } from "./doctor.js";

describe("doctor helpers (REQ-GEN-08)", () => {
  it("REQ-GEN-08/AC1: a missing tool is reported by its own failed check or the check that covers it, else not at all", () => {
    const checks = [
      { name: "android", ok: false, detail: "missing adb" },
      { name: "docker", ok: true, detail: "Docker 24" },
    ];
    expect(reportedBy("emulator", checks)).toBe("android");
    expect(reportedBy("android sdk", checks)).toBe("android");
    expect(reportedBy("android", checks)).toBe("android");
    // A passing check covers nothing: a missing Compose next to a working Docker is its own error.
    expect(reportedBy("compose", checks)).toBeUndefined();
    expect(reportedBy("java", checks)).toBeUndefined();
  });

  it("REQ-GEN-08/AC3: only a secrets file others can read is a warning; Windows is skipped", () => {
    expect(secretFileCheck({ path: "/p/.env.local", mode: 0o100600, platform: "darwin" })).toBeUndefined();
    expect(secretFileCheck({ path: "/p/.env.local", mode: 0o100644, platform: "win32" })).toBeUndefined();
    const group = secretFileCheck({ path: "/p/.env.local", mode: 0o100640, platform: "linux" });
    expect(group?.detail).toBe(
      "/p/.env.local can be read by other users of this machine (mode 640); fix: chmod 600 /p/.env.local",
    );
    expect(group?.ok).toBe(true);
    expect(formatDoctor(group ? [group] : [])).toMatch(/^! secrets file: /);
  });
});
