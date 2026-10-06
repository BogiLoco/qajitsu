# `qajitsu fetch`

Fetches a ticket and the code that implements it into a new run folder (roadmap stage 1).

```text
qajitsu fetch <TICKET> [--pr <url>]... [--mr <url>]... [--ref <[repo=]branch|tag|sha>]...
```

What it does:

1. Validates the key (`SHOP-482`) before any network call (REQ-CTX-01/AC3).
2. Creates `<root>/<TICKET>/<RUN-ID>/` with all subfolders, `run.json` and an updated `index.json` (REQ-WS-01).
   The root is `workspace.root` from `.qa/qa.project.yaml`, default `<project-home>/runs/` (ADR-0006).
3. Stores the ticket snapshot in `ticket/ticket.json` and `ticket/ticket.md`; later stages never refetch it (REQ-CTX-01/AC2).
4. Finds the change (REQ-CTX-03): `--pr`/`--mr`/`--ref` if given, otherwise the strategies in `change_discovery`
   (Jira development panel, ticket key in branch names, ticket key in PR/MR titles). One change per repository.
   If nothing is found it asks in an interactive terminal and stops in CI. It never tests the default branch silently.
5. Writes `repos/<alias>.diff`, `repos/<alias>.change.json` (change + review comments) and `repos/changes.json`.
6. Updates the bare mirror in `workspace.git_cache` (default `<project-home>/cache/git/`) and adds a worktree at the exact SHA
   under `repos/<alias>/`; the SHA is recorded in `run.json` (REQ-CTX-04).
7. Journals every step in `journal/events.jsonl`; logs go to `logs/qajitsu.log`, masked.

Credentials come from `secret://` references (environment or `.env.local`, REQ-CFG-03). Git receives them through
environment variables only, never on the command line or in the mirror config.

## Exit codes

| Code | Meaning                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------- |
| 0    | Context fetched                                                                                 |
| 3    | Invalid key, configuration error, ticket or code host unreachable, no change found, git failure |

## Demo

```sh
pnpm build
node examples/demo-shop/scripts/setup-demo-repo.mjs   # creates ~/.qa-demo/git/demo-org/demo-shop
cd examples/demo-shop && node ../../packages/cli/dist/bin.js fetch DEMO-1
```
