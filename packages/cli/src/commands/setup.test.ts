import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerProject, setActiveProject } from "@qajitsu/core";
import type { RunExec, ToolchainEnv } from "@qajitsu/toolchain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProgram } from "../program.js";
import { formatStep, hostOf, toolList, versionFlags } from "./setup.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "qj-setup-cli-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const JDK = "fake jdk";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A machine without Java, where the installers' commands work inside the temp folder. */
function fakeMachine() {
  const calls: string[] = [];
  const run: RunExec = async (cmd, args) => {
    calls.push(`${cmd.split("/").at(-1) ?? cmd} ${args.join(" ")}`);
    const touch = async (file: string) => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "#!/bin/sh\n");
    };
    if (cmd === "curl") await writeFile(args[args.indexOf("--output") + 1] ?? "", JDK);
    if (cmd === "tar")
      await touch(join(args[args.indexOf("-C") + 1] ?? "", "jdk", "Contents", "Home", "bin", "java"));
    if (cmd.endsWith("/java")) return { code: 0, stdout: "", stderr: 'openjdk version "17.0.20.1"' };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

async function project(mobile: boolean): Promise<string> {
  const qa = join(home, "repo", ".qa");
  await mkdir(qa, { recursive: true });
  await writeFile(
    join(qa, "qa.project.yaml"),
    [
      "project: shop",
      "jira: { type: file, tickets_dir: t, project_key: SHOP }",
      ...(mobile
        ? [
            "test_types: [mobile]",
            "mobile:",
            "  appium: { url: http://appium.example.test:4723 }",
            "  android: { app: { source: path, repo: shop, path: a.apk }, app_id: a.b }",
          ]
        : []),
    ].join("\n"),
  );
  await registerProject(join(home, ".qajitsu"), { slug: "shop", qaDir: qa });
  await setActiveProject(join(home, ".qajitsu"), "shop");
  return qa;
}

async function qj(args: string[], machine = fakeMachine(), withAsk = false) {
  let out = "";
  let err = "";
  let exitCode = 0;
  const applied: ToolchainEnv[] = [];
  const program = createProgram("1.2.3", {
    write: (t) => (out += t),
    writeError: (t) => (err += t),
    cwd: home,
    nodeVersion: "v22.22.0",
    setExitCode: (c) => (exitCode = c),
    applyEnv: (env) => applied.push(env),
    ...(withAsk ? { ask: () => Promise.resolve("n") } : {}),
    ports: {
      env: {},
      home,
      now: () => new Date("2026-10-09T10:00:00.000Z"),
      random: () => 0,
      fetch: () => Promise.resolve(new Response("", { status: 200 })),
      gitExec: () => Promise.resolve({ stdout: "", stderr: "" }),
      // Nothing on this machine answers: no Java, no adb.
      versionExec: (cmd) =>
        Promise.resolve(cmd === "sysctl" ? "1" : ["curl", "tar", "unzip"].includes(cmd) ? "ok" : undefined),
      playwright: () => ({ version: "1.63.0", browsers: [] }),
      toolchain: {
        host: { os: "darwin", arch: "arm64" },
        run: machine.run,
        freeBytes: () => Promise.resolve(500 * 1024 ** 3),
        totalMemory: 16 * 1024 ** 3,
        artifacts: {
          java: {
            url: "https://github.com/adoptium/temurin17-binaries/releases/download/x/OpenJDK17U.tar.gz",
            size: 190 * 1048576,
            checksum: { algorithm: "sha256", value: sha(JDK) },
          },
        },
      },
    },
  }).exitOverride();
  await program.parseAsync(["node", "qajitsu", ...args]).catch(() => undefined);
  return { out, err, exitCode, applied, calls: machine.calls };
}

describe("qj setup (REQ-GEN-06)", () => {
  it("REQ-GEN-06/AC4: --check --json prints the plan and changes nothing; the project line goes to stderr", async () => {
    await project(true);
    const r = await qj(["setup", "--check", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(r.err).toContain("Project: shop");
    const plan = JSON.parse(r.out) as { steps: { tool: string; action: string; version: string }[] };
    expect(plan.steps.filter((s) => s.action !== "skip").map((s) => [s.tool, s.action, s.version])).toEqual([
      ["java", "install", "17.0.20.1+1"],
      ["android", "install", "sdk"],
    ]);
    expect(r.calls).toEqual([]);
    expect(existsSync(join(home, ".qajitsu", "toolchain"))).toBe(false);
  });

  it("REQ-GEN-06/AC3: installs into ~/.qajitsu/toolchain; the next command passes JAVA_HOME to its tools", async () => {
    await project(true);
    const r = await qj(["setup", "--yes", "--only", "java"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/↓ java +install 17\.0\.20\.1\+1, 190 MB from https:\/\/github\.com\/adoptium/);
    expect(r.out).toMatch(/✔ java +ready: java 17\.0\.20\.1 runs/);
    expect(r.out).toContain(
      "Licences accepted:\n  - java: GPL-2.0 with Classpath Exception (Eclipse Temurin)",
    );
    const javaHome = join(home, ".qajitsu", "toolchain", "java", "17.0.20.1+1", "Contents", "Home");
    expect(existsSync(join(javaHome, "bin", "java"))).toBe(true);
    const next = await qj(["projects", "current"]);
    expect(next.applied).toEqual([]);
    const doctor = await qj(["doctor"]);
    expect(doctor.applied[0]?.vars["JAVA_HOME"]).toBe(javaHome);
    expect(doctor.applied[0]?.path).toEqual([join(javaHome, "bin")]);
    expect(doctor.applied[0]?.vars["HOMEBREW_NO_ANALYTICS"]).toBe("1");
    // The choice is the project's: the shell is never touched.
    const choice = JSON.parse(
      await readFile(join(home, ".qajitsu", "projects", "shop", "toolchain.json"), "utf8"),
    ) as {
      tools: Record<string, unknown>;
    };
    expect(choice.tools["java"]).toEqual({ use: "managed", version: "17.0.20.1+1", path: javaHome });
    const removed = await qj(["setup", "--uninstall", "java"]);
    expect(removed.out).toContain("✔ removed java 17.0.20.1+1");
    expect(existsSync(javaHome)).toBe(false);
  });

  it("REQ-GEN-06/AC4: without --yes and without a terminal, setup stops and says how to go on", async () => {
    await project(true);
    const r = await qj(["setup", "--only", "java"]);
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain("Stopped: setup needs your confirmation");
    expect(r.calls).toEqual([]);
    const declined = await qj(["setup", "--only", "java"], fakeMachine(), true);
    expect(declined.out).toContain("Stopped: licences not accepted; nothing was changed");
  });

  it("REQ-GEN-06/AC4+AC5: wrong flags are refused before anything happens", async () => {
    await project(false);
    for (const [args, message] of [
      [["setup", "--only", "python"], "--only: unknown tool python"],
      [["setup", "--version", "java"], "--version java: expected <tool>=<version>"],
      [["setup", "--uninstall"], "--uninstall needs a tool"],
      [["setup", "--download", "a", "--from", "b"], "--download and --from cannot be used together"],
    ] as const) {
      const r = await qj([...args]);
      expect(r.exitCode).toBe(2);
      expect(r.err).toContain(message);
    }
    const nothing = await qj(["setup", "--uninstall", "--all"]);
    expect(nothing.exitCode).toBe(0);
  });

  it("REQ-GEN-06/AC1: without a project nothing is needed; --only names the tools", async () => {
    const r = await qj(["setup", "--check"]);
    expect(r.err).toContain("No project: nothing is needed. Name the tools with --only");
    expect(r.out).toMatch(/· java +skip: not needed by this project/);
  });

  it("REQ-GEN-06/AC9: doctor shows what setup would do and --fix installs what is missing", async () => {
    await project(true);
    const before = await qj(["doctor"]);
    expect(before.out).toContain("Toolchain (qj setup):");
    expect(before.out).toMatch(/↓ java +install 17\.0\.20\.1\+1/);
    expect(before.out).toContain("install: qj setup --only java");
    expect(before.exitCode).toBe(3);
    const fixed = await qj(["doctor", "--fix", "--yes"]);
    expect(fixed.out).toContain("qj doctor --fix: qj setup --only java,android");
    expect(fixed.calls.some((c) => c.startsWith("curl"))).toBe(true);
  });

  it("REQ-GEN-06/AC7: doctor --online checks that the toolchain sources answer", async () => {
    await project(true);
    await writeFile(
      join(home, ".qajitsu", "toolchain.yaml"),
      "sources:\n  npm_registry: https://npm.example.test/\n",
    );
    const r = await qj(["doctor", "--online"]);
    expect(r.out).toContain("✔ source npm registry: https://npm.example.test/ answers (200)");
    expect(r.out).toContain(
      "✔ source Android repository: https://dl.google.com/android/repository/repository2-3.xml answers (200)",
    );
  });
});

describe("setup flags and output", () => {
  it("parses tool lists and versions strictly", () => {
    expect(toolList(["java,android", "java"], "--only")).toEqual(["java", "android"]);
    expect(versionFlags(["java=21", "appium=3.7.0"])).toEqual({ java: "21", appium: "3.7.0" });
    expect(() => versionFlags(["java=latest"])).toThrow(/expected <tool>=<version>/);
    expect(hostOf("linux", "x64")).toEqual({ os: "linux", arch: "x64" });
    expect(() => hostOf("win32", "x64")).toThrow(/macOS and Linux/);
  });

  it("prints each plan line with what, version, size, source and why", () => {
    const base = { version: "1", bytes: 0, source: "s", licence: "l", reason: "r", parts: [] as string[] };
    expect(
      formatStep({
        ...base,
        tool: "android",
        action: "install",
        version: "sdk",
        bytes: 3 * 1024 ** 3,
        parts: ["emulator"],
      }),
    ).toBe("  ↓ android      install sdk (emulator), 3.0 GB from s: r");
    expect(formatStep({ ...base, tool: "docker", action: "start" })).toBe("  ▶ docker       start: r");
    expect(formatStep({ ...base, tool: "java", action: "use-managed" })).toBe(
      "  ✔ java         use QAJitsu's 1: r",
    );
    expect(formatStep({ ...base, tool: "docker", action: "manual" })).toBe("  ! docker       manual: r");
    expect(formatStep({ ...base, tool: "xcode", action: "unsupported" })).toBe(
      "  ✘ xcode        unsupported: r",
    );
  });
});
