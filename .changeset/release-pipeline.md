---
"@qajitsu/cli": patch
"@qajitsu/verifier": patch
---

Releases of installable packages (REQ-GEN-15).

- Every package carries its licence, notice, readme, repository, Node.js engine and public access, and ships its
  TypeScript source so source maps and stack traces point at real lines. All packages release at one version.
- CI checks on every pull request that the packages install with npm and with pnpm and run.
- `qj doctor` no longer asks a new project for a knowledge store plugin while its knowledge base is empty: `qj init`
  creates the folder, and only sources or an index need the store.
- Only the CLI's own installation counts as bundled plugins: a package in a folder above it, in `NODE_PATH` or in a
  global folder is never trusted as one. Bundled plugins are found whether or not they were built.
- The spec type check fails closed: without the steps types every spec is blocked, and a steps import that resolves
  anywhere else is refused. An installed QAJitsu checks specs against the built steps types, not the shipped sources.
- Dependencies with known high vulnerabilities are updated: zod 4.6.6, undici 6.29.1 and 7.30.1, body-parser 2.4.0,
  follow-redirects 1.16.2.
