import { isAbsolute, relative } from "node:path";

const HOST_MODES = ["network_mode", "pid", "ipc", "uts", "userns_mode", "cgroup"] as const;
const LOOPBACK = new Set(["127.0.0.1", "::1"]);

const inside = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });

/**
 * Checks the effective compose model (`docker compose config --format json`) of the analysed branch
 * before anything starts. The compose file comes from the change under test, so it must not reach
 * the host: no privileged containers, added capabilities, devices or host namespaces, no bind mounts
 * outside the allowed roots or of the Docker socket, no build context outside them, and ports
 * published on loopback only (REQ-ENV-03, invariant 10).
 *
 * @param model - Parsed JSON of `docker compose config`.
 * @param allowedRoots - Directories bind mounts and build contexts may come from (worktree, `.qa/`).
 * @returns Problems, one per finding; empty when the model is acceptable.
 */
export function checkComposeModel(model: unknown, allowedRoots: readonly string[]): string[] {
  const problems: string[] = [];
  const services = (model as { services?: Record<string, Record<string, unknown>> } | null)?.services ?? {};
  for (const [name, svc] of Object.entries(services)) {
    if (svc["privileged"] === true) problems.push(`${name}: privileged containers are not allowed`);
    if (Array.isArray(svc["cap_add"]) && svc["cap_add"].length > 0)
      problems.push(`${name}: cap_add is not allowed`);
    if (Array.isArray(svc["devices"]) && svc["devices"].length > 0)
      problems.push(`${name}: devices are not allowed`);
    for (const key of HOST_MODES)
      if (typeof svc[key] === "string" && /^host$/i.test(svc[key]))
        problems.push(`${name}: ${key}: host is not allowed`);
    if (
      Array.isArray(svc["security_opt"]) &&
      svc["security_opt"].some((o) => String(o).includes("unconfined"))
    )
      problems.push(`${name}: unconfined security options are not allowed`);
    for (const v of Array.isArray(svc["volumes"]) ? (svc["volumes"] as Record<string, unknown>[]) : []) {
      const source = typeof v["source"] === "string" ? v["source"] : "";
      if (v["type"] !== "bind") continue;
      if (source.includes("docker.sock")) problems.push(`${name}: mounting the Docker socket is not allowed`);
      else if (!isAbsolute(source) || !inside(source, allowedRoots))
        problems.push(`${name}: bind mount ${source} is outside the worktree`);
    }
    const build = svc["build"] as { context?: unknown } | undefined;
    if (typeof build?.context === "string" && !inside(build.context, allowedRoots))
      problems.push(`${name}: build context ${build.context} is outside the worktree`);
    for (const p of Array.isArray(svc["ports"]) ? (svc["ports"] as Record<string, unknown>[]) : []) {
      const published = typeof p["published"] === "number" ? String(p["published"]) : p["published"];
      if (typeof published !== "string" || published === "") continue;
      const hostIp = typeof p["host_ip"] === "string" ? p["host_ip"] : "";
      if (!LOOPBACK.has(hostIp))
        problems.push(
          `${name}: port ${String(p["published"])} is published on ${hostIp || "all interfaces"}`,
        );
    }
  }
  return problems;
}
