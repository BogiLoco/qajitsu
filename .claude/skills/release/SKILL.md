---
name: release
description: Prepare a QAJitsu release with Changesets - check pending changesets, version packages, update changelogs, open the release PR. Never publishes from a local machine.
disable-model-invocation: true
---

# /release

Publishing to npm happens only in CI (`.github/workflows/release.yml`) after the release PR merges. Locally you only prepare.

1. Ensure `main` is up to date and `/verify` passes.
2. `pnpm changeset status` – list pending changesets. If user-visible changes since the last tag have no changeset, stop and list them.
3. Check bump types: breaking change to CLI flags, exit codes, config schema, statuses or evidence format → major (or minor while `0.x`, called out explicitly in the changelog).
4. `pnpm changeset version` – updates versions and `CHANGELOG.md` files. Review the generated changelog for clarity; rewrite entries that only make sense to maintainers.
5. Run `/verify` again, then commit `chore(release): version packages` on a `release/<version>` branch.
6. Push and open the PR only if the user asks. Never run `npm publish` or `pnpm publish` locally; the guard blocks it.
