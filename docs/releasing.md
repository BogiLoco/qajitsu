# Releasing QAJitsu

Releases come from CI only (REQ-GEN-15). Nobody publishes from a laptop: `pnpm release` and every package's
`prepublishOnly` refuse to run outside the Release workflow on `main` of this repository (`scripts/publish-guard.mjs`).

## How a release happens

1. Pull requests carry changesets (`pnpm changeset`) for what users notice.
2. When a pull request with changesets merges into `main`, the **Release** workflow (`.github/workflows/release.yml`)
   opens or updates one pull request, `chore(release): version packages`. It is made by code
   (`pnpm version-packages`):
   - versions and `CHANGELOG.md` of every changed package (`changeset version`);
   - `packages/cli/plugins.json`, the plugin versions this CLI installs (`scripts/plugin-catalogue.mjs`);
   - the lockfile and the formatting of what was generated.
3. Read the changelogs in that pull request and rewrite entries that only make sense to maintainers. While QAJitsu is
   `0.x`, a breaking change is a minor version and says so in its entry.
4. Merging it publishes. Every package has the same version: changesets keeps `@qajitsu/*` in one fixed group, so a
   change to one package releases all of them at the next version.

The workflow has two jobs:

- **test**, with read rights and no secrets, runs everything that executes dependency code: the install, `pnpm verify`,
  the contract tests of every plugin as installed from its tarball (`tests/e2e/plugins-installed.e2e.test.ts`) and the
  full release check below.
- **release** starts only after it, in the `npm-publish` environment, with the write rights and the npm token. With
  pending changesets it only opens or updates the version pull request. Without them, `pnpm release` publishes:
  1. the publish guard;
  2. `pnpm clean` and `pnpm build`, so no stale file reaches a package;
  3. the release check without installs (`--no-install`): the tarballs that are published are inspected again;
  4. `pnpm -r publish` with npm provenance: pnpm, not npm, because only pnpm turns `workspace:` ranges into versions;
     a package already in the registry at that version is skipped, so a release that stopped half-way can run again;
  5. `scripts/release-tags.mjs` tags each published version (`changeset git-tag`), and `scripts/github-release.mjs`
     pushes the tags and creates one GitHub release with the CLI's changelog.

The npm token reaches the publish step only. Every action is pinned to a commit.

## The release check

`node scripts/release-check.mjs` (also `pnpm release:check`) runs on every pull request in CI and before every
publish. It packs every package as the release would and refuses when a tarball:

- lacks a file that its `main`, `types`, `exports` or `bin` names;
- keeps a `workspace:` dependency;
- carries tests, build info, environment or key files, or stale build output;
- has a source map that points outside the package;
- misses its `LICENSE`, `NOTICE` or `README.md`, its repository, its Node.js engine or public access;
- has a version other than the release's, or is over 3 MB packed.

Then it installs the CLI from those tarballs with npm into an empty folder, the way a user does, without running any
install script, and runs it with an empty home and no model keys:

- `--version` and `--help`;
- `init` of a new project;
- adding the API runner plugin from its tarball, and the refusal to remove it while the project needs it;
- adding and removing a plugin the project does not need;
- `doctor`, which must find nothing to fix;
- the spec type check of the installed verifier, in the npm layout and in pnpm's: a correct spec passes, one calling a
  method that does not exist is blocked, against the installed build of `@qajitsu/steps`.

The installation must stay under 200 MB and must not contain a plugin that should be installed on demand.

Useful options: `--no-install` (pack and inspect only), `--keep` (keep the work folder to look at it).

## What the repository needs once

- An npm organisation `qajitsu` that owns the `@qajitsu` scope.
- A GitHub environment `npm-publish` (Settings → Environments), limited to the `main` branch, with required reviewers if
  a person should approve each release, holding the secret `NPM_TOKEN`: a granular npm token with publish rights on the
  `@qajitsu` packages only and an expiry date. The first publish of each package needs a token. After it, switch the
  packages to npm trusted publishing for this workflow, revoke the token and set the packages to require two-factor
  authentication and disallow tokens.
- Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests", so the workflow can open
  the version pull request.
- Optionally the secret `RELEASE_PR_TOKEN`: a GitHub App or fine-grained token with contents and pull-request rights. A
  pull request opened with the workflow's own token gets no CI checks, so with required checks the version pull
  request would need an administrator to merge it.
- The version pull request is one commit: merge it with a merge commit or a squash.

## Notes

- The publish guard (`scripts/publish-guard.mjs`) protects against accidents, not against an attacker: it can be
  skipped. What protects the packages is where the token lives: in the environment, reachable by the publish step only.
- `pnpm -r publish` hands each tarball to npm, which signs the provenance. pnpm 11 publishes natively: check provenance
  again before `packageManager` moves past pnpm 10.
