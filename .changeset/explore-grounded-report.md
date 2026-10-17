---
"@qajitsu/agents": minor
"@qajitsu/cli": minor
"@qajitsu/core": minor
"@qajitsu/report": minor
---

Exploratory sessions report a checklist and findings that code checks against the recorded actions (REQ-EXEC-25).
`qj explore --check "<item>"` (repeatable) gives the goal's checklist; every item ends up done with its actions or not
done with the reason, never silently dropped. Invented action ids and, for command-line tools, flags that no command
ran are refused, items left undone are sent back once while the step budget lasts, and refused answers are journaled
(`explore.answer_rejected`). `session.json` gains `checklist` and `findings`; the report shows them before the
explorer's comment, and the terminal says how many items were done. The explorer's answer is now
`{checklist, findings, summary}` instead of `{summary}`.
