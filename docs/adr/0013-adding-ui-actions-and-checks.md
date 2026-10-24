# ADR-0013: Adding UI actions and checks

- Status: accepted
- Date: 2026-10-24
- Related: ADR-0004, ADR-0002, INV-1, INV-2, INV-4, INV-7, INV-8, INV-10, REQ-EXEC-38, REQ-EXEC-39, REQ-EXEC-40,
  REQ-EXEC-56

## Context

QAJitsu tests web pages through a small set of actions (`goto`, `click`, `fill`, `check`, `select`, `press`,
`waitFor`, `back`, `as`). Real applications also need uploads and downloads, frames and pop-ups, hover, drag and drop,
scrolling, Shadow DOM and canvas content (REQ-EXEC-38..40, REQ-EXEC-56), and more will follow for mobile and other
protocols. Each new capability touches the same places; without one pattern each would weaken a different guarantee.

## Decision

Every new UI capability is added along the same path, and only along it:

1. **The spec asks, the trusted parent acts (ADR-0004).** A spec gets a method on `ui`; the sandbox sends an operation
   that is validated by a Zod schema in `runner-api`'s sandbox; the parent's runtime (`@qajitsu/steps`) checks it again
   and calls the `UiDriver`. The spec never touches the browser, a file or the network.
2. **Inputs come from the approved plan or the project, never from the spec.** A spec names an input by its plan key
   (for example the file `avatar` of the case's `files`); the parent resolves it from `.qa/fixtures/` or generates it
   from the plan. A path, a URL or bytes from a spec are refused.
3. **Actual values are read by the parent.** New checks are new `verify()` fields (`download.*`, `elements.*` with new
   properties, `state.*`, `visual` of an element) whose actual value the parent reads from the page, the download or the
   application's test hook; a spec passes `undefined` as before (INV-1, INV-4).
4. **Everything is evidence.** Uploaded and downloaded files, the pages of a case and the action log go into the
   manifest with their SHA-256 (INV-7); text is masked before it is stored (INV-8).
5. **The allowlist holds everywhere.** Frames, pop-ups and new tabs load only allowlisted origins; a page outside it
   makes the step BLOCKED with the host named (INV-10).
6. **Unknown never passes.** A missing download, an unreachable frame, a closed shadow root, a scroll limit reached or
   unreadable content is a failed step or BLOCKED with the reason, never PASSED.
7. **Static checks know the action.** `spec-checks` accepts the new methods, applies the selector rules to their
   selector arguments, refuses them where the platform cannot do them (mobile until its driver can), and the
   assertion lock treats new `verify()` fields like the others. The healer may change the selectors of new actions,
   never their inputs or checks.
8. **The author knows it.** The author's prompt lists the action with its rules; nothing else teaches the model.
9. **Detection is proven.** The demo shop gets a page using the capability and a seeded bug; the self-test shows the
   bug FAILED with its flag and PASSED without it.

## Consequences

- A new action is several small changes in known places (steps, sandbox, child, runtime, driver, spec-checks, prompt,
  plan schema when it needs inputs or expectations, demo shop) rather than one large one; reviewers check the list.
- Platforms without a capability refuse it statically, so a plan for them is changed before it runs, not discovered
  as a runtime error.
- Content extraction of downloads (PDF, XLSX) is injected into the runtime by the CLI, so `@qajitsu/steps` stays free
  of document libraries.
