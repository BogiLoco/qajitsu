---
"@qajitsu/core": minor
"@qajitsu/agents": minor
"@qajitsu/cli": patch
---

Large changes and semantic signals (REQ-CTX-19, REQ-CTX-20): a change too large for the analyst's budget is split by
code per repository and per group of related files (a module with its tests), each part analysed in its own call;
code merges the parts (duplicates removed, sources joined, questions renumbered) and checks every source again. The
split, the parts and their snapshots are journaled and kept in `analysis.parts.json`; the planner of a split change
gets the diffs behind handles. With a local embedding model from the project's hybrid knowledge index, similarity to
the task is a second ranking signal, near-identical fragments confirmed by code are sent once, `search_context`
also searches by meaning, and a lone file can join the group it resembles; vectors are cached by hash and model and
the model is named in the snapshot. Without one, or when it fails, the code's signals alone decide. Lessons of
earlier runs (false FAILED from `qj feedback`, escaped defects, revisions people asked for) reach the analyst and
planner as low-priority data fragments (`collectLessons` in `@qajitsu/core`).
