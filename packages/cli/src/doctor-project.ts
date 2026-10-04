import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { devNull, platform } from "node:os";
import { join, resolve } from "node:path";
import { androidSdkRoot } from "@qajitsu/adapter-runner-mobile";
import { createMasker } from "@qajitsu/steps";
import { parse } from "yaml";
import { buildAdapters, createCliSecretResolver, type RuntimePorts } from "./adapters.js";
import type { DoctorCheck } from "./doctor.js";
import { createCliLogger } from "./logger.js";
import type { LoadedProject } from "./project.js";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const run = (cmd: string, args: readonly string[]): Promise<string | undefined> =>
  new Promise((done) => {
    execFile(cmd, [...args], { timeout: 15_000 }, (e, out) => {
      done(e ? undefined : out.trim());
    });
  });

/** Every `secret://` reference in a parsed YAML value. */
const secretRefs = (value: unknown, out = new Set<string>()): Set<string> => {
  if (typeof value === "string" && value.startsWith("secret://")) out.add(value);
  else if (Array.isArray(value)) for (const v of value) secretRefs(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) secretRefs(v, out);
  return out;
};

/**
 * Project checks of `qajitsu doctor` (REQ-GEN-03/AC2): secrets resolvable (names only), Docker for
 * `--build`, Android SDK, emulator image and Appium for mobile, iOS availability, and with `online`
 * access to Jira and every code host.
 *
 * @param project - Loaded project.
 * @param ports - Runtime ports (environment, fetch, git).
 * @param options - `online` makes real requests to Jira and the code hosts.
 */
export async function projectChecks(
  project: LoadedProject,
  ports: RuntimePorts,
  options: { readonly online: boolean },
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const masker = createMasker();
  const resolveSecret = createCliSecretResolver(project, ports, masker);
  const refs = secretRefs(project.config);
  for (const f of (await readdir(join(project.qaDir, "envs")).catch(() => [])).filter((x) =>
    /\.ya?ml$/.test(x),
  ))
    secretRefs(parse(await readFile(join(project.qaDir, "envs", f), "utf8")) as unknown, refs);
  const missing: string[] = [];
  for (const ref of refs)
    if (
      !(await resolveSecret(ref).then(
        () => true,
        () => false,
      ))
    )
      missing.push(ref);
  checks.push({
    name: "secrets",
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `${String(refs.size)} reference(s) resolve`
        : `cannot resolve ${missing.join(", ")}`,
  });

  const services = Object.values(project.config.services);
  if (services.some((s) => s.kind !== "process")) {
    const version = await run("docker", ["version", "--format", "{{.Server.Version}}"]);
    checks.push({
      name: "docker",
      ok: version !== undefined,
      detail: version ? `Docker ${version}` : "docker is not available (needed by --build)",
    });
  }

  const mobile = project.config.mobile;
  if (mobile?.android) {
    const sdk = androidSdkRoot(mobile.android.sdk_root);
    const tools = [join(sdk, "platform-tools", "adb"), join(sdk, "emulator", "emulator")];
    const image = mobile.android.emulator?.system_image.split(";").slice(1);
    const missingTools = [
      ...(await Promise.all(tools.map(async (t) => ((await exists(t)) ? undefined : t)))).filter(
        (t): t is string => t !== undefined,
      ),
      ...(image && !(await exists(join(sdk, "system-images", ...image)))
        ? [mobile.android.emulator?.system_image ?? ""]
        : []),
    ];
    checks.push({
      name: "android",
      ok: missingTools.length === 0,
      detail: missingTools.length === 0 ? `SDK ${sdk}` : `missing ${missingTools.join(", ")}`,
    });
  }
  if (mobile && !mobile.appium.url) {
    const bin =
      mobile.appium.bin?.includes("/") === true
        ? resolve(project.qaDir, mobile.appium.bin)
        : (mobile.appium.bin ?? "appium");
    const version = await run(bin, ["--version"]);
    checks.push({
      name: "appium",
      ok: version !== undefined,
      detail: version ? `Appium ${version}` : `${bin} not found`,
    });
  }
  if (mobile?.ios && !mobile.ios.farm)
    checks.push({
      name: "ios",
      ok: platform() === "darwin" && (await run("xcrun", ["simctl", "help"])) !== undefined,
      detail: "local iOS needs macOS with Xcode; or configure mobile.ios.farm",
    });

  if (options.online) {
    const logger = createCliLogger({ file: devNull, mask: (v) => masker.maskJson(v) });
    const { ticketSource, codeHosts } = buildAdapters(
      project,
      {
        fetch: ports.fetch,
        logger,
        now: ports.now,
        resolveSecret,
        registerSecret: (v) => {
          masker.register(v);
        },
      },
      ports,
    );
    const jira = (await ticketSource.check?.()) ?? { ok: true, detail: "no check available" };
    checks.push({ name: "jira", ...jira });
    for (const [alias, host] of Object.entries(codeHosts)) {
      const r = (await host.check?.()) ?? { ok: true, detail: "no check available" };
      checks.push({ name: `code host ${alias}`, ...r });
    }
  }
  return checks.map((c) => ({ ...c, detail: masker.maskText(c.detail) }));
}
