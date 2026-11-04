---
name: release
description: Prepare a QAJitsu release with Changesets - check pending changesets, version packages, update changelogs, open the release PR. Never publishes from a local machine.
disable-model-invocation: true
---

# /release

Publishing to npm happens only in CI (`.github/workflows/release.yml`) after the version PR merges; the workflow opens
that PR itself from the pending changesets (`pnpm version-packages`). Locally you only check. Details: `docs/releasing.md`.

1. Ensure `main` is up to date and `/verify` passes.
2. `pnpm changeset status` – list pending changesets. If user-visible changes since the last tag have no changeset, stop and list them.
3. Check bump types: breaking change to CLI flags, exit codes, config schema, statuses or evidence format → major (or minor while `0.x`, called out explicitly in the changelog).
4. `pnpm build && pnpm release:check` – packs, inspects and installs what would be published; fix every problem it lists.
5. After the merge to `main`, review the changelogs in the `chore(release): version packages` PR the workflow opened;
   rewrite entries that only make sense to maintainers.
6. Never publish locally; the guard hook and `scripts/publish-guard.mjs` refuse it.
