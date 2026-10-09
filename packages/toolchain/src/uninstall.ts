import { rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { appiumBinOf } from "./installers.js";
import { acquireSetupLock } from "./lock.js";
import type { ToolId } from "./manifest.js";
import type { RunExec } from "./network.js";
import { managedAndroid, managedAppiumHome } from "./plan.js";
import { forgetInstalled, readToolchainRecord, type InstalledTool } from "./registry.js";

/** Outcome of an uninstall (REQ-GEN-06/AC5). */
export interface UninstallReport {
  readonly removed: readonly InstalledTool[];
  readonly kept: readonly { readonly entry: InstalledTool; readonly reason: string }[];
  /** Tools asked for that QAJitsu never installed: nothing of the user's is touched. */
  readonly notInstalled: readonly ToolId[];
}

/** Ports of {@link uninstallTools}. */
export interface UninstallPorts {
  readonly run: RunExec;
  readonly node: string;
  readonly playwrightCli: string;
  readonly log: (line: string) => void;
}

/** Whether a path is strictly inside a folder (a tampered record must never point the removal elsewhere). */
export const isInside = (path: string, folder: string): boolean => {
  const rel = relative(resolve(folder), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !rel.includes(`..${sep}`);
};

/** The folder of a managed entry that is removed: the version folder, not `Contents/Home` inside it. */
function folderOf(entry: InstalledTool, root: string): string {
  if (entry.tool === "java") {
    const parts = relative(root, entry.path).split(sep);
    return join(root, parts[0] ?? "java", parts[1] ?? "");
  }
  return entry.path;
}

/**
 * Removes what QAJitsu installed, by its record (REQ-GEN-06/AC5): one tool (every version of it) or, with `all`,
 * everything plus the download cache. Docker and Xcode are system-wide and are never removed; tools QAJitsu did not
 * install are not touched; a recorded path outside the toolchain folder is refused. Playwright's browsers are removed
 * with Playwright's own uninstall, which keeps the ones another installation still uses.
 *
 * @param root - The toolchain folder.
 * @param tools - The tools to remove, or `all`.
 */
export async function uninstallTools(
  root: string,
  tools: readonly ToolId[] | "all",
  ports: UninstallPorts,
): Promise<UninstallReport> {
  const lock = await acquireSetupLock(root);
  try {
    const record = await readToolchainRecord(root);
    const wanted = (e: InstalledTool): boolean => tools === "all" || tools.includes(e.tool);
    const removed: InstalledTool[] = [];
    const kept: { entry: InstalledTool; reason: string }[] = [];
    for (const entry of record.tools.filter(wanted)) {
      if (entry.system) {
        kept.push({ entry, reason: "system-wide: QAJitsu installs it once and never removes it" });
        continue;
      }
      if (entry.tool === "browsers") {
        const out = await ports.run(ports.node, [ports.playwrightCli, "uninstall"]);
        if (out.code === 0) removed.push(entry);
        else kept.push({ entry, reason: `playwright uninstall failed: ${out.stderr.trim().slice(-200)}` });
        continue;
      }
      if (entry.tool === "uiautomator2" || entry.tool === "xcuitest") {
        const others = record.tools.filter(
          (t) => (t.tool === "uiautomator2" || t.tool === "xcuitest") && t !== entry && !wanted(t),
        );
        const home = managedAppiumHome(root);
        if (others.length === 0) await rm(home, { recursive: true, force: true });
        else {
          const appium = record.tools.find((t) => t.tool === "appium");
          await ports.run(appium ? appiumBinOf(appium.path) : "appium", ["driver", "uninstall", entry.tool], {
            env: { APPIUM_HOME: home },
          });
        }
        removed.push(entry);
        continue;
      }
      const folder = folderOf(entry, root);
      if (!isInside(folder, root)) {
        kept.push({ entry, reason: `${folder} is outside ${root}; refused` });
        continue;
      }
      ports.log(`removing ${entry.tool} ${entry.version} (${folder})`);
      await rm(folder, { recursive: true, force: true });
      if (entry.tool === "android") await rm(managedAndroid(root).avd, { recursive: true, force: true });
      removed.push(entry);
    }
    await forgetInstalled(root, (e) => !removed.some((r) => r.tool === e.tool && r.version === e.version));
    if (tools === "all") await rm(join(root, ".downloads"), { recursive: true, force: true });
    const notInstalled = tools === "all" ? [] : tools.filter((t) => !record.tools.some((e) => e.tool === t));
    return { removed, kept, notInstalled };
  } finally {
    await lock.release();
  }
}
