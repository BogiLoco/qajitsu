// Every package QAJitsu releases (REQ-GEN-15/AC3): what npm and its users need to install, trust and debug it.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const REPOSITORY = "git+https://github.com/BogiLoco/qajitsu.git";

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly description?: string;
  readonly license?: string;
  readonly repository?: { readonly type?: string; readonly url?: string; readonly directory?: string };
  readonly homepage?: string;
  readonly bugs?: { readonly url?: string };
  readonly engines?: { readonly node?: string };
  readonly publishConfig?: { readonly access?: string; readonly provenance?: boolean };
  readonly files?: readonly string[];
  readonly exports?: Record<string, Record<string, string>>;
  readonly bin?: Record<string, string>;
}

const packageDirs = (): string[] =>
  [
    ...readdirSync(join(root, "packages")).map((d) => join(root, "packages", d)),
    ...readdirSync(join(root, "packages", "adapters")).map((d) => join(root, "packages", "adapters", d)),
  ].filter((d) => existsSync(join(d, "package.json")));

const packages = packageDirs().map((dir) => ({
  dir,
  rel: relative(root, dir),
  manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest,
}));
const published = packages.filter((p) => p.manifest.private !== true);

describe("packages ready to publish (REQ-GEN-15/AC3)", () => {
  it("REQ-GEN-15/AC3: every published package names its licence, repository folder, Node.js engine and public access", () => {
    expect(published.length).toBeGreaterThan(25);
    for (const { rel, manifest: m } of published) {
      expect(m.name, rel).toMatch(/^@qajitsu\/[a-z][a-z0-9-]*$/);
      expect(m.description?.length ?? 0, `${rel}: description`).toBeGreaterThan(20);
      expect(m.license, rel).toBe("Apache-2.0");
      // npm provenance is refused unless the repository is the one the workflow runs in.
      expect(m.repository, rel).toEqual({ type: "git", url: REPOSITORY, directory: rel });
      expect(m.homepage, rel).toBe(`https://github.com/BogiLoco/qajitsu/tree/main/${rel}#readme`);
      expect(m.bugs, rel).toEqual({ url: "https://github.com/BogiLoco/qajitsu/issues" });
      expect(m.engines?.node, rel).toBe(">=22.12.0");
      expect(m.publishConfig, rel).toEqual({ access: "public", provenance: true });
    }
  });

  it("REQ-GEN-15/AC3: packages ship their build and the source their maps point to, never their tests", () => {
    for (const { rel, manifest: m } of published) {
      expect(m.files, rel).toEqual(expect.arrayContaining(["dist", "src", "!src/**/*.test.ts", "NOTICE"]));
      // The `qajitsu-source` condition and the source maps point into src/, so src/ must be in the package.
      for (const [entry, conditions] of Object.entries(m.exports ?? {}))
        for (const [condition, target] of Object.entries(conditions))
          expect(target, `${rel} exports ${entry} ${condition}`).toMatch(
            condition === "qajitsu-source" ? /^\.\/src\// : /^\.\/dist\//,
          );
      for (const target of Object.values(m.bin ?? {})) expect(target, `${rel} bin`).toMatch(/^\.\/dist\//);
    }
  });

  it("REQ-GEN-15/AC3: every published package carries the licence, the notice and a readme of its own", () => {
    const licence = readFileSync(join(root, "LICENSE"), "utf8");
    for (const { dir, rel } of published) {
      expect(existsSync(join(dir, "LICENSE")), `${rel}/LICENSE`).toBe(true);
      expect(readFileSync(join(dir, "LICENSE"), "utf8"), `${rel}/LICENSE`).toBe(licence);
      // Apache-2.0, section 4(d): the NOTICE goes with every copy.
      expect(readFileSync(join(dir, "NOTICE"), "utf8"), `${rel}/NOTICE`).toBe(
        readFileSync(join(root, "NOTICE"), "utf8"),
      );
      expect(existsSync(join(dir, "README.md")), `${rel}/README.md`).toBe(true);
      const readme = readFileSync(join(dir, "README.md"), "utf8");
      expect(readme, rel).toContain(published.find((p) => p.rel === rel)?.manifest.name ?? "?");
    }
  });

  it("REQ-GEN-15/AC3: plugins tell how they are installed", () => {
    for (const { dir, rel } of published.filter((p) => p.rel.startsWith("packages/adapters/"))) {
      const id = rel.slice("packages/adapters/".length);
      const catalogue = JSON.parse(readFileSync(join(root, "packages", "cli", "plugins.json"), "utf8")) as {
        plugins: Record<string, unknown>;
      };
      expect(catalogue.plugins[id], `${id} in plugins.json`).toBeDefined();
      expect(readFileSync(join(dir, "README.md"), "utf8"), rel).toMatch(
        new RegExp(`qj plugin add ${id}|comes with the CLI`),
      );
    }
  });

  it("REQ-GEN-15/AC2: every package releases in step, from one version", () => {
    const versions = new Set(published.map((p) => p.manifest.version));
    expect([...versions]).toHaveLength(1);
  });
});
