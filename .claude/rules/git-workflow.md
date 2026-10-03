# Git workflow

- Branches: `feat/<short-name>`, `fix/<short-name>`, `docs/...`, `chore/...`. Never commit directly to `main`.
- Commits: Conventional Commits with a package scope, e.g. `feat(verifier): reject PASSED without evidence`, `fix(adapter-gitlab): handle self-hosted base_url`.
- One logical change per commit. Run `/verify` before each commit; never use `--no-verify`.
- User-visible or public API change: add a changeset (`pnpm changeset`) in the same PR.
- PR description: what and why, link to the roadmap stage or issue, test evidence (commands run), and any invariant the change touches.
- Do not push, force-push, tag or publish unless the user explicitly asks. Releases run from CI only.
