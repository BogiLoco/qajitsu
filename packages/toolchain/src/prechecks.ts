import type { ProbeExec } from "./detect.js";
import type { Host, ToolId } from "./manifest.js";
import type { ToolchainNeeds } from "./needs.js";
import { changingSteps, type PlanStep } from "./plan.js";

const GIB = 1024 * 1024 * 1024;

/** Ports of {@link runPrechecks}. */
export interface PrecheckPorts {
  readonly host: Host;
  readonly exec: ProbeExec;
  readonly exists: (path: string) => boolean;
  /** Free bytes on the file system of a folder (the nearest existing parent is asked). */
  readonly freeBytes: (path: string) => Promise<number | undefined>;
  readonly totalMemory: number;
  /** Linux: /dev/kvm can be opened for reading and writing by this user. */
  readonly kvmAccessible: () => boolean;
}

/** One precheck (REQ-GEN-06/AC6). A failed one stops setup before anything is downloaded. */
export interface Precheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** Tools a failure is about; `--skip` them to set up the rest. */
  readonly tools: readonly ToolId[];
}

/** The emulator ABI that runs at native speed on this processor. */
export const nativeAbi = (host: Host): string => (host.arch === "arm64" ? "arm64-v8a" : "x86_64");

const imageAbi = (image: string): string | undefined => image.split(";").at(-1);

async function emulatorChecks(needs: ToolchainNeeds, ports: PrecheckPorts): Promise<Precheck[]> {
  const emulator = needs.android?.emulator;
  if (!emulator) return [];
  const out: Precheck[] = [];
  // Google publishes the emulator for Linux x86_64 and macOS (x86_64, arm64) only (repository2-3.xml).
  const built = !(ports.host.os === "linux" && ports.host.arch === "arm64");
  out.push({
    name: "emulator build",
    ok: built,
    detail: built
      ? `the Android emulator is published for ${ports.host.os} ${ports.host.arch}`
      : "the Android emulator has no build for Linux on ARM64; run Android tests against a device farm or another machine with mobile.appium.url, or --skip android",
    tools: ["android"],
  });
  const abi = imageAbi(emulator.systemImage);
  const native = nativeAbi(ports.host);
  const abiOk = abi === native || (native === "x86_64" && abi === "x86");
  out.push({
    name: "system image",
    ok: abiOk,
    detail: abiOk
      ? `${emulator.systemImage} runs natively on ${ports.host.arch}`
      : `${emulator.systemImage} is built for ${abi ?? "?"}, this ${ports.host.arch} machine runs ${native} images; set mobile.android.emulator.system_image to the ${native} variant`,
    tools: ["android"],
  });
  const accel =
    ports.host.os === "darwin"
      ? (await ports.exec("sysctl", ["-n", "kern.hv_support"]))?.trim() === "1"
      : ports.exists("/dev/kvm") && ports.kvmAccessible();
  const farm =
    "the emulator cannot run here; run Android tests against a device farm or another machine with mobile.appium.url, or --skip android";
  out.push({
    name: "virtualisation",
    ok: accel,
    detail: accel
      ? ports.host.os === "darwin"
        ? "Hypervisor.framework (HVF) is available"
        : "/dev/kvm is available"
      : ports.host.os === "darwin"
        ? `Hypervisor.framework (HVF) is not available; ${farm}`
        : `/dev/kvm is missing or not accessible (add the user to the kvm group; in a VM, enable nested virtualisation); ${farm}`,
    tools: ["android"],
  });
  const memory = ports.totalMemory;
  out.push({
    name: "memory",
    ok: memory >= 4 * GIB,
    detail:
      memory >= 8 * GIB
        ? `${(memory / GIB).toFixed(0)} GiB`
        : memory >= 4 * GIB
          ? `${(memory / GIB).toFixed(0)} GiB; the emulator runs, 8 GiB or more is recommended`
          : `${(memory / GIB).toFixed(1)} GiB; the emulator needs at least 4 GiB; ${farm}`,
    tools: ["android"],
  });
  return out;
}

/**
 * Checks before anything is downloaded (REQ-GEN-06/AC6): the processor (which system images run natively), hardware
 * virtualisation for the emulator (HVF on macOS, KVM on Linux), memory, free disk space for what the plan downloads
 * and unpacks, and the programs setup itself uses (curl, tar, unzip).
 *
 * @param steps - The setup plan.
 * @param needs - What the project needs.
 * @param root - The toolchain folder (its file system must have the space).
 */
export async function runPrechecks(
  steps: readonly PlanStep[],
  needs: ToolchainNeeds,
  ports: PrecheckPorts,
  root: string,
): Promise<Precheck[]> {
  const changing = changingSteps(steps);
  const out: Precheck[] = [
    {
      name: "processor",
      ok: true,
      detail: `${ports.host.os} ${ports.host.arch}; Android system images: ${nativeAbi(ports.host)}`,
      tools: [],
    },
  ];
  const android = steps.find((s) => s.tool === "android");
  if (android && android.action !== "skip" && android.action !== "unsupported")
    out.push(...(await emulatorChecks(needs, ports)));
  const downloads = changing.filter((s) => s.tool === "java" || s.tool === "android");
  for (const [program, args] of [
    ["curl", ["--version"]],
    ["tar", ["--version"]],
    ["unzip", ["-v"]],
  ] as const) {
    if (downloads.length === 0) break;
    const found = (await ports.exec(program, args)) !== undefined;
    out.push({
      name: program,
      ok: found,
      detail: found ? "found" : `${program} is needed to download and unpack tools; install it first`,
      tools: downloads.map((s) => s.tool),
    });
  }
  const bytes = changing.reduce((sum, s) => sum + s.bytes, 0);
  if (bytes > 0) {
    // Archives are kept until they are unpacked: about 2.5 times the download, plus 1 GiB to spare.
    const needed = bytes * 2.5 + GIB;
    const free = await ports.freeBytes(root);
    out.push({
      name: "disk",
      ok: free === undefined || free >= needed,
      detail:
        free === undefined
          ? "free space unknown"
          : `${(free / GIB).toFixed(1)} GiB free, about ${(needed / GIB).toFixed(1)} GiB needed`,
      tools: changing.map((s) => s.tool),
    });
  }
  return out;
}
