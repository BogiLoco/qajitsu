#!/usr/bin/env node
// Image check (REQ-GEN-09/AC4..AC6): runs a built QAJitsu image and refuses it when its version or labels are wrong,
// it runs as root, it carries a secret or a credential file, its plugins are missing, a run in it does not record the
// image by digest, or the offline demo does not catch the seeded bug.
//
//   node scripts/image-check.mjs <image> <version>
//   node scripts/image-check.mjs --layers-only <image>      only the layer scan (an image of another platform)
//
// The image is one built from scripts/image-context.mjs with ci/docker/Dockerfile.release (locally, in a pull
// request, or the released image by digest after it was pushed).

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Largest uncompressed image; Chromium and its system libraries are most of it. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024 * 1024;
/** A digest the check passes to a run, to see it recorded. */
export const PROBE_DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;

/** Environment variable names that must never be baked into the image. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;
/** What a leaked credential looks like in a file. */
export const SECRET_PATTERN =
  "gh[opsur]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|npm_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}";
/**
 * Tokens specific enough to look for in binaries too: their prefixes do not occur in data by chance, unlike `AKIA`
 * followed by capitals, which Unicode tables and Node.js carry.
 */
export const TOKEN_IN_BINARY =
  /gh[opsur]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|npm_[A-Za-z0-9]{36}|sk-ant-[A-Za-z0-9_-]{20,}/;
/**
 * A private key with its key material: the header alone is a format string that system libraries, Node.js and npm's
 * documentation carry; a leaked key has base64 after it.
 */
export const PRIVATE_KEY =
  /-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----\s+[A-Za-z0-9+/=]{40}/;

/**
 * Whether a file's content holds a credential (REQ-GEN-09/AC6): a token of a known kind, or a private key with its
 * key material.
 *
 * @param {Buffer | string} content
 */
export function holdsCredential(content) {
  const text = typeof content === "string" ? content : content.toString("latin1");
  return new RegExp(SECRET_PATTERN).test(text) || PRIVATE_KEY.test(text);
}

/**
 * Whether a file is binary, the way `grep -I` decides: a NUL byte in its first 8 kB. Credentials leak as text (a
 * config, an env file, a PEM key); binaries from the distribution and Node.js carry test keys and random data that
 * look like them.
 *
 * @param {Buffer} content
 */
export function isBinary(content) {
  return content.subarray(0, 8192).includes(0);
}

/** Every regular file below a folder (symbolic links are not followed). */
function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else if (entry.isFile()) visit(full);
  }
}

/**
 * Problems of the image's configuration (REQ-GEN-09/AC4+AC6), from `docker image inspect`.
 *
 * @param {{ Config?: { User?: string, Env?: string[], Labels?: Record<string, string> }, Size?: number }} inspect
 * @param {string} version
 */
export function configProblems(inspect, version) {
  const out = [];
  const config = inspect.Config ?? {};
  const user = config.User ?? "";
  if (user === "" || user === "root" || user === "0" || user.startsWith("0:"))
    out.push(`the image runs as ${user || "root"}`);
  const labels = config.Labels ?? {};
  const want = {
    "org.opencontainers.image.version": version,
    "org.opencontainers.image.source": "https://github.com/BogiLoco/qajitsu",
    "org.opencontainers.image.licenses": "Apache-2.0",
  };
  for (const [key, value] of Object.entries(want))
    if (labels[key] !== value) out.push(`label ${key} is ${String(labels[key])}, expected ${value}`);
  if (!/^[0-9a-f]{40}$/.test(labels["org.opencontainers.image.revision"] ?? ""))
    out.push(
      `label org.opencontainers.image.revision is ${String(labels["org.opencontainers.image.revision"])}, expected a commit`,
    );
  const env = Object.fromEntries(
    (config.Env ?? []).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]),
  );
  for (const name of Object.keys(env))
    if (SECRET_NAME.test(name)) out.push(`the image sets ${name}: no secret goes into an image`);
  if (env["QAJITSU_IMAGE"] !== `ghcr.io/bogiloco/qajitsu:${version}`)
    out.push(
      `QAJITSU_IMAGE is ${String(env["QAJITSU_IMAGE"])}, expected ghcr.io/bogiloco/qajitsu:${version}`,
    );
  if (typeof inspect.Size === "number" && inspect.Size > MAX_IMAGE_BYTES)
    out.push(
      `the image is ${String(Math.round(inspect.Size / 1024 / 1024))} MB, the budget is ${String(MAX_IMAGE_BYTES / 1024 / 1024)} MB`,
    );
  return out;
}

/**
 * One command the check runs in the image, with what its output and exit code must be.
 *
 * @param {string} version
 */
export function imageSteps(version) {
  const v = version.replace(/\./g, "\\.");
  return [
    { label: "version", args: ["--version"], codes: [0], expect: [new RegExp(`^${v}\\s*$`, "m")] },
    { label: "user", entrypoint: "id", args: ["-u"], codes: [0], expect: [/^[1-9]\d*\s*$/] },
    {
      label: "plugins",
      args: ["plugin", "list"],
      codes: [0, 3],
      expect: [new RegExp(`✔ runner-api\\s+${v}`), new RegExp(`✔ runner-web\\s+${v}`)],
    },
    {
      // Credential files anywhere QAJitsu, its user or a build could have left one (searched as root).
      label: "no credential files",
      entrypoint: "sh",
      user: "0",
      args: [
        "-c",
        [
          "find /opt /home /root /tmp /work /usr/local/lib /etc/qajitsu -xdev",
          "\\( -name '.env' -o -name '.env.*' -o -name '.npmrc' -o -name '.netrc' -o -name '*.pem' -o -name '*.key' -o -name 'id_rsa*' -o -name '.git-credentials' \\)",
          "! -name '.env.example' -exec sh -c",
          // npm ships an empty .npmrc of its own: a config file counts when it holds a token, password or login.
          '\'for f; do case "$f" in *.npmrc|*.netrc|*.git-credentials) grep -qiE "authtoken|_auth|password|machine|https://[^ ]*:[^ ]*@" "$f" && echo "$f";; *) echo "$f";; esac; done\'',
          "sh {} + 2>/dev/null; echo end-of-search",
        ].join(" "),
      ],
      codes: [0],
      expect: [/^end-of-search\s*$/],
    },
    {
      label: "no secrets in files",
      entrypoint: "sh",
      user: "0",
      args: [
        "-c",
        `grep -rIlE '${SECRET_PATTERN}' /opt/qajitsu /home /root 2>/dev/null; grep -rIlzP '${PRIVATE_KEY.source}' /opt/qajitsu /home /root 2>/dev/null; echo end-of-search`,
      ],
      codes: [0],
      expect: [/^end-of-search\s*$/],
    },
    {
      // A run in the image records it by digest (REQ-GEN-09/AC4): doctor lists what a run records.
      label: "image digest recorded",
      entrypoint: "sh",
      env: { QAJITSU_IMAGE_DIGEST: PROBE_DIGEST },
      args: [
        "-c",
        "mkdir -p /tmp/p && cd /tmp/p && git init -q && echo '{}' > package.json && qajitsu init image-check --yes >/dev/null || true; qajitsu doctor || true",
      ],
      codes: [0],
      expect: [
        new RegExp(
          `qajitsu image\\s+ghcr\\.io/bogiloco/qajitsu@${PROBE_DIGEST} \\(declared when the container was started, not verified\\)`,
        ),
      ],
    },
    {
      // REQ-GEN-09/AC5: the demo-shop flow with one container command and nothing else installed.
      label: "demo",
      args: ["demo"],
      codes: [0],
      expect: [/TC-01":"FAILED/, /The bug was caught/],
    },
  ];
}

/** File names that are credentials wherever they are, in any layer (`.env.example` is documentation). */
const CREDENTIAL_FILE =
  /(^|\/)(\.env(\.(?!example$)[^/]*)?|\.git-credentials|id_rsa[^/]*|id_ed25519[^/]*|[^/]+\.(pem|key|p12|pfx))$/;

/**
 * Credential files among the paths of one image layer (REQ-GEN-09/AC6). Every layer counts: a file deleted in a later
 * layer is still published in this one. System certificate bundles are not credentials.
 *
 * @param {string[]} paths - The layer's paths, as `tar -t` lists them.
 */
export function layerFileProblems(paths) {
  return paths
    .map((p) => p.replace(/^\.\//, ""))
    .filter(
      (p) =>
        CREDENTIAL_FILE.test(p) &&
        !/^(etc\/ssl|usr\/share\/ca-certificates|usr\/lib\/ssl|usr\/local\/share\/ca-certificates)\//.test(p),
    )
    .map((p) => `a layer carries ${p}`);
}

/** Every layer of a saved image: file names checked, contents searched for credentials. */
function layerProblems(image) {
  const dir = mkdtempSync(join(tmpdir(), "qj-image-layers-"));
  try {
    const saved = docker(["save", "-o", join(dir, "image.tar"), image]);
    if (saved.code !== 0) return [`docker save failed: ${saved.out}`];
    spawnSync("tar", ["-xf", join(dir, "image.tar"), "-C", dir]);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const out = [];
    for (const layer of manifest[0]?.Layers ?? []) {
      const file = join(dir, layer);
      const list = spawnSync("tar", ["-tf", file], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      out.push(
        ...layerFileProblems((list.stdout ?? "").split("\n").filter(Boolean)).map((p) => `${p} (${layer})`),
      );
      // Contents, file by file: a credential deleted in a later layer is still published in this one.
      const unpacked = join(dir, "unpacked", layer.replace(/[^\w]/g, "_"));
      mkdirSync(unpacked, { recursive: true });
      spawnSync("tar", ["-xf", file, "-C", unpacked], { stdio: "ignore" });
      walk(unpacked, (path) => {
        // Whiteouts mark deletions and are empty; a file the layer keeps unreadable is made readable, and one that
        // still cannot be read is a problem, never skipped (fail closed).
        if (basename(path).startsWith(".wh.")) return;
        let content;
        try {
          content = readFileSync(path);
        } catch {
          try {
            chmodSync(path, 0o600);
            content = readFileSync(path);
          } catch {
            out.push(`a layer has a file that cannot be read: ${relative(unpacked, path)} (${layer})`);
            return;
          }
        }
        if (isBinary(content) ? TOKEN_IN_BINARY.test(content.toString("latin1")) : holdsCredential(content))
          out.push(`a layer holds a credential: ${relative(unpacked, path)} (${layer})`);
      });
      rmSync(unpacked, { recursive: true, force: true });
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether a step's output and exit code are what it expects. */
export function stepProblems(step, code, output) {
  const out = [];
  if (!step.codes.includes(code)) out.push(`exit ${String(code)}, expected ${step.codes.join(" or ")}`);
  for (const re of step.expect) if (!re.test(output)) out.push(`output lacks ${String(re)}`);
  return out;
}

const docker = (args) => {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

/** Only the layer scan, for an image of another platform that is not run here (arm64 in the release). */
function layersOnly(image) {
  const found = layerProblems(image);
  process.stdout.write(
    `${found.length === 0 ? "ok  " : "FAIL"} every layer of ${image}: no credential files or secrets\n`,
  );
  for (const p of found) process.stderr.write(`- ${p}\n`);
  if (found.length > 0) process.exitCode = 1;
}

function main(image, version) {
  const problems = [];
  const inspect = docker(["image", "inspect", image]);
  if (inspect.code !== 0) throw new Error(`docker image inspect ${image} failed:\n${inspect.out}`);
  const config = configProblems(JSON.parse(inspect.out)[0] ?? {}, version);
  process.stdout.write(`${config.length === 0 ? "ok  " : "FAIL"} configuration\n`);
  problems.push(...config);
  const layers = layerProblems(image);
  process.stdout.write(
    `${layers.length === 0 ? "ok  " : "FAIL"} every layer: no credential files or secrets\n`,
  );
  problems.push(...layers);
  for (const step of imageSteps(version)) {
    const args = [
      "run",
      "--rm",
      "--network",
      // REQ-GEN-09/AC5: everything, the demo included, runs without a network.
      "none",
      ...(step.entrypoint ? ["--entrypoint", step.entrypoint] : []),
      ...(step.user ? ["--user", step.user] : []),
      ...Object.entries(step.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      image,
      ...step.args,
    ];
    const r = docker(args);
    const found = stepProblems(step, r.code, r.out);
    process.stdout.write(`${found.length === 0 ? "ok  " : "FAIL"} ${step.label}\n`);
    if (found.length > 0) problems.push(`${step.label}: ${found.join("; ")}\n${r.out.slice(-3000)}`);
  }
  if (problems.length > 0) {
    process.stderr.write(`\nImage check refused ${image} (${String(problems.length)} problems):\n`);
    for (const p of problems) process.stderr.write(`- ${p}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`\nImage check passed: ${image}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [image, version] = process.argv.slice(2);
  if (image === "--layers-only" && version) layersOnly(version);
  else if (!image || !version) {
    process.stderr.write("usage: node scripts/image-check.mjs <image> <version>\n");
    process.exitCode = 1;
  } else
    try {
      main(image, version);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
}
