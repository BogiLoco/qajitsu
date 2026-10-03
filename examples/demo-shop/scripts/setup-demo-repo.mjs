#!/usr/bin/env node
// Creates the local git repository the demo-shop config points at (~/.qa-demo/git/demo-org/demo-shop):
// `main` with the demo-shop sources and `feature/DEMO-1-cart-discounts` with the DEMO-1 change.
// Usage: node examples/demo-shop/scripts/setup-demo-repo.mjs [--root <dir>]
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shop = join(here, "..");
const rootIndex = process.argv.indexOf("--root");
const root = rootIndex > 0 ? process.argv[rootIndex + 1] : join(homedir(), ".qa-demo", "git");
const repo = join(root, "demo-org", "demo-shop");

const git = (...args) =>
  execFileSync("git", ["-C", repo, "-c", "user.name=demo", "-c", "user.email=demo@example.com", ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  })
    .toString()
    .trim();

if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main", repo]);

for (const entry of ["README.md", "BUGS.md", "api", "web", "docker-compose.yml", "package.json"]) {
  if (existsSync(join(shop, entry))) cpSync(join(shop, entry), join(repo, entry), { recursive: true });
}
writeFileSync(join(repo, "CHANGELOG.md"), "# demo-shop\n");
git("add", "-A");
git("commit", "-qm", "demo-shop baseline");

git("checkout", "-qb", "feature/DEMO-1-cart-discounts");
writeFileSync(
  join(repo, "CHANGELOG.md"),
  "# demo-shop\n\n- DEMO-1: discount codes in cart, total rounded once.\n",
);
git("commit", "-qam", "DEMO-1 discount codes in cart");
const sha = git("rev-parse", "HEAD");
git("checkout", "-q", "main");

process.stdout.write(
  `demo repository ready: ${repo}\nDEMO-1 change: feature/DEMO-1-cart-discounts @ ${sha}\n`,
);
