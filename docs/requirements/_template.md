# Requirement template

Copy the block below into the right area file, replace `AREA` and `NN` with the area prefix and the next free number.
This file is ignored by `pnpm req:check`.

```markdown
### REQ-AREA-NN · Short title in sentence case

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-AREA-NN, INV-n, ADR-nnnn

One or two sentences: what problem this solves and for whom. Non-goals if useful.

**Acceptance criteria**

- [ ] AC1: Observable behaviour, testable without reading the implementation.
- [ ] AC2: Error or edge case behaviour (what happens when it fails).
```

Checklist for a good requirement:

- One capability per requirement; split if the acceptance criteria describe unrelated things.
- Criteria describe behaviour, not implementation ("the guard denies...", not "add a function...").
- Failure behaviour is explicit, and it never turns an unknown into PASSED (see `INV-1`).
- `Related` lists the invariants it protects and the requirements it depends on.
