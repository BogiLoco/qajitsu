---
"@qajitsu/core": minor
"@qajitsu/agents": minor
---

Context manager, second phase (REQ-CTX-11/AC3, REQ-CTX-13): every agent role (analyst, planner, author, healer,
approver, explorers, blocked hints) builds its input from fragments; `runStructuredAgent` and `prepareCall` accept only
an assembled context, so no prompt can be built around the manager. Every role declares the kinds of context it may
see; the approver and the auditor never see the analysis or tool transcripts. New fragment kinds `spec`, `ui`,
`imported`, `exploration`, `map`. `renderTestsRepo` returns plain text; `renderChangeContext` renders the same
fragments for previews.
