---
name: requirement
description: Add, change, deprecate, find or trace QAJitsu requirements in docs/requirements/. Use when the user asks for a new feature or behaviour change, when work is not covered by an existing requirement, when ticking acceptance criteria after implementation, or to show which code and tests cover a requirement.
argument-hint: "[add <idea> | change REQ-X-NN <what> | deprecate REQ-X-NN <why> | trace REQ-X-NN | status [stage N]]"
allowed-tools: Read Grep Glob Edit Bash(pnpm req:check) Bash(pnpm req:index) Bash(pnpm req:list *) Bash(node scripts/requirements.mjs *) Bash(git grep *) Bash(git log *)
---

# /requirement $ARGUMENTS

Format, statuses and lifecycle are defined in `docs/requirements/README.md`; read it if unsure. The template is `docs/requirements/_template.md`.

## add <idea>

1. Search first: `git grep -n -i "<key words>" docs/requirements/`. If an existing requirement covers it, propose a **change** instead.
2. Pick the area file by topic (CTX, PLAN, ENV, CFG, WS, EXEC, VER, EVD, PUB, LLM, OBS, CI, GEN, NFR). If nothing fits, ask the user before creating a new area.
3. Next free number = highest number in that file + 1 (ids are never reused, including deprecated ones).
4. Write it from the template:
   - title in sentence case; one capability per requirement (split if criteria describe unrelated things);
   - `Status: proposed` unless the user explicitly agreed to it (`accepted`);
   - `Priority` (must/should/could) and `Stage` (1–10 or `later`) from `docs/roadmap.md`; if unclear, propose and ask;
   - `Related`: requirements it depends on and invariants it protects (`INV-n`), ADRs (`ADR-nnnn`); `-` for none;
   - acceptance criteria `AC1..ACn`: observable, testable, including failure behaviour. Unknown or error states must never become PASSED (INV-1).
5. If it belongs to a roadmap stage, nothing else to edit: the roadmap lists are generated.
6. Run `pnpm req:index` then `pnpm req:check`. Show the user the new requirement text.

## change REQ-X-NN <what>

- Edit in place; keep the id and numbering of existing criteria. New criteria get the next `ACn`.
- If the requirement is `implemented` and the meaning changes: untick affected criteria and set `in-progress`.
- Scope changes that turn it into a different capability: add a new requirement, deprecate the old one with `Replaced by REQ-...`.
- Update `Related` on both sides when you add a dependency. Run `pnpm req:index` and `pnpm req:check`.

## deprecate REQ-X-NN <why>

Set `Status: deprecated`, add a line `Deprecated: <reason>` (and `Replaced by REQ-...` if applicable) under the metadata. Never delete the block. Check `git grep -n "REQ-X-NN"` for references in code, tests and other requirements and report them.

## trace REQ-X-NN

Report, for each acceptance criterion: tests that reference it (`git grep -n "REQ-X-NN/AC" -- '*.test.*' tests/`), code comments that reference it, commits (`git log --oneline --grep "REQ-X-NN"`), and whether the tick state matches reality (ticked without a test, or tested but unticked). Propose corrections; apply them only if the user asks.

## status [stage N]

`pnpm req:list -- --stage N` (or `--status in-progress`). Summarize: done vs open criteria, `must` items still open, and the next requirement to pick (lowest stage, `must`, dependencies in `Related` already implemented).

## After implementing work (called from /tdd or /verify)

Tick only criteria that are implemented **and** covered by a test titled with that criterion. Set `in-progress` / `implemented`. Run `pnpm req:index` and `pnpm req:check`. Mention the ticked criteria in the commit footer: `Refs: REQ-X-NN`.
