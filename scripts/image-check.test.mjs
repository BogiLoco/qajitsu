import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  PROBE_DIGEST,
  SECRET_PATTERN,
  TOKEN_IN_BINARY,
  configProblems,
  holdsCredential,
  imageSteps,
  isBinary,
  layerFileProblems,
  stepProblems,
} from "./image-check.mjs";

const REVISION = "a".repeat(40);
const good = {
  Size: 1_500_000_000,
  Config: {
    User: "qa",
    Env: ["PATH=/usr/bin", "QAJITSU_HOME=/home/qa/.qajitsu", "QAJITSU_IMAGE=ghcr.io/bogiloco/qajitsu:0.1.0"],
    Labels: {
      "org.opencontainers.image.version": "0.1.0",
      "org.opencontainers.image.source": "https://github.com/BogiLoco/qajitsu",
      "org.opencontainers.image.licenses": "Apache-2.0",
      "org.opencontainers.image.revision": REVISION,
    },
  },
};

describe("image check: configuration (REQ-GEN-09/AC4+AC6)", () => {
  it("REQ-GEN-09/AC6: a non-root image with its labels, its name and no secret passes", () => {
    expect(configProblems(good, "0.1.0")).toEqual([]);
  });

  it("REQ-GEN-09/AC6: root, a baked secret, wrong labels, a wrong name or an oversized image are refused", () => {
    const bad = {
      Size: MAX_IMAGE_BYTES + 1,
      Config: {
        User: "",
        Env: [
          "GITHUB_TOKEN=x",
          "NPM_PASSWORD=y",
          "QAJITSU_IMAGE=ghcr.io/bogiloco/qajitsu:latest",
          "NO_EQUALS",
        ],
        Labels: { "org.opencontainers.image.version": "0.0.9", "org.opencontainers.image.revision": "main" },
      },
    };
    expect(configProblems(bad, "0.1.0")).toEqual([
      "the image runs as root",
      "label org.opencontainers.image.version is 0.0.9, expected 0.1.0",
      "label org.opencontainers.image.source is undefined, expected https://github.com/BogiLoco/qajitsu",
      "label org.opencontainers.image.licenses is undefined, expected Apache-2.0",
      "label org.opencontainers.image.revision is main, expected a commit",
      "the image sets GITHUB_TOKEN: no secret goes into an image",
      "the image sets NPM_PASSWORD: no secret goes into an image",
      "QAJITSU_IMAGE is ghcr.io/bogiloco/qajitsu:latest, expected ghcr.io/bogiloco/qajitsu:0.1.0",
      `the image is ${String(Math.round((MAX_IMAGE_BYTES + 1) / 1024 / 1024))} MB, the budget is 2048 MB`,
    ]);
    for (const user of ["root", "0", "0:0"])
      expect(configProblems({ ...good, Config: { ...good.Config, User: user } }, "0.1.0")).toEqual([
        `the image runs as ${user}`,
      ]);
    expect(configProblems({}, "0.1.0")).toContain("the image runs as root");
  });
});

describe("image check: what runs in the image (REQ-GEN-09/AC4..AC6)", () => {
  const steps = imageSteps("0.1.0");
  const step = (label) => steps.find((s) => s.label === label);

  it("REQ-GEN-09/AC4..AC6: every step checks its output, not only its exit code", () => {
    expect(steps.map((s) => s.label)).toEqual([
      "version",
      "user",
      "plugins",
      "no credential files",
      "no secrets in files",
      "image digest recorded",
      "demo",
    ]);
    expect(stepProblems(step("version"), 0, "0.1.0\n")).toEqual([]);
    expect(stepProblems(step("version"), 0, "0.1.01\n")).toEqual(["output lacks /^0\\.1\\.0\\s*$/m"]);
    expect(stepProblems(step("user"), 0, "10001\n")).toEqual([]);
    expect(stepProblems(step("user"), 0, "0\n")).toHaveLength(1);
    expect(
      stepProblems(step("plugins"), 0, "✔ runner-api   0.1.0 installed\n✔ runner-web   0.1.0 installed"),
    ).toEqual([]);
    expect(
      stepProblems(step("plugins"), 0, "✔ runner-api   0.1.0\n· runner-web   not installed"),
    ).toHaveLength(1);
    expect(stepProblems(step("no credential files"), 0, "end-of-search\n")).toEqual([]);
    expect(stepProblems(step("no credential files"), 0, "/home/qa/.npmrc\nend-of-search\n")).toHaveLength(1);
    expect(
      stepProblems(
        step("image digest recorded"),
        0,
        `  ✔ qajitsu image  ghcr.io/bogiloco/qajitsu@${PROBE_DIGEST} (declared when the container was started, not verified)`,
      ),
    ).toEqual([]);
    expect(
      stepProblems(
        step("image digest recorded"),
        0,
        "  ✔ qajitsu image  ghcr.io/bogiloco/qajitsu:0.1.0 (digest not given)",
      ),
    ).toHaveLength(1);
    expect(stepProblems(step("demo"), 0, 'with BUG-01: {"TC-01":"FAILED"}\nThe bug was caught')).toEqual([]);
    expect(stepProblems(step("demo"), 1, "Unexpected statuses.")).toEqual([
      "exit 1, expected 0",
      'output lacks /TC-01":"FAILED/',
      "output lacks /The bug was caught/",
    ]);
  });

  it("REQ-GEN-09/AC6: the secret search finds the credentials it is meant to find", () => {
    const re = new RegExp(SECRET_PATTERN);
    // Built at run time, so no file of the repository holds something that looks like a credential.
    const leaks = [
      ["gh", "p_", "a".repeat(36)],
      ["np", "m_", "B".repeat(36)],
      ["AK", "IA", "ABCDEFGHIJKLMNOP"],
      ["sk-", "ant-", "x".repeat(30)],
    ].map((parts) => parts.join(""));
    for (const leak of leaks) expect(re.test(leak), leak).toBe(true);
    expect(re.test("export const TOKEN_HEADER = 'authorization';")).toBe(false);
    // The searches run as root, so nothing is hidden behind permissions.
    expect(step("no credential files")?.user).toBe("0");
    expect(step("no secrets in files")?.user).toBe("0");
  });

  it("REQ-GEN-09/AC6: credential files are found in any layer, system certificates are not", () => {
    expect(
      layerFileProblems([
        "./opt/qajitsu/demo/examples/demo-shop/.env.example",
        "etc/ssl/certs/ca-certificates.crt",
        "usr/share/ca-certificates/mozilla/x.pem",
        "tmp/qajitsu/.env",
        "home/qa/.ssh/id_ed25519",
        "opt/x/server.key",
        "root/.git-credentials",
        "opt/qajitsu/node_modules/x/index.js",
      ]),
    ).toEqual([
      "a layer carries tmp/qajitsu/.env",
      "a layer carries home/qa/.ssh/id_ed25519",
      "a layer carries opt/x/server.key",
      "a layer carries root/.git-credentials",
    ]);
  });

  it("REQ-GEN-09/AC6: a private key counts with its key material, not the format string libraries carry", () => {
    const header = ["-----BEGIN ", "OPENSSH PRIVATE", " KEY-----"].join("");
    const body = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW";
    expect(holdsCredential(`${header}\n${body}\n`)).toBe(true);
    expect(holdsCredential(Buffer.from(`\0\0${header}\r\n${body}`, "latin1"))).toBe(true);
    // gnutls, libssh2, node and npm's docs carry the header as a string.
    expect(holdsCredential(`printf("${header}\\n"); /* then the key */`)).toBe(false);
    expect(holdsCredential(Buffer.from(`\x7fELF${header}\0%s\0`, "latin1"))).toBe(false);
    expect(holdsCredential(["gh", "p_", "c".repeat(36)].join(""))).toBe(true);
    expect(holdsCredential("nothing here")).toBe(false);
    // The workflow token itself (ghs_) and the other GitHub token kinds.
    for (const kind of ["ghs", "gho", "ghu", "ghr"])
      expect(holdsCredential(`${kind}_${"k".repeat(36)}`), kind).toBe(true);
    // In binaries only the specific tokens count: a GitHub token yes, capitals after AKIA (Unicode tables) no.
    expect(TOKEN_IN_BINARY.test(`\0\0${["gh", "s_", "a".repeat(36)].join("")}`)).toBe(true);
    expect(TOKEN_IN_BINARY.test("\0AKIAISLANDISSHARITAL")).toBe(false);
    // Layers are scanned like grep -I: a binary (a NUL in its first 8 kB) is the distribution's, not a leak.
    expect(isBinary(Buffer.from(`\x7fELF\0\0${header}\n${body}`, "latin1"))).toBe(true);
    expect(isBinary(Buffer.from(`${header}\n${body}\n`))).toBe(false);
    expect(isBinary(Buffer.concat([Buffer.alloc(9000, 65), Buffer.from([0])]))).toBe(false);
  });
});
