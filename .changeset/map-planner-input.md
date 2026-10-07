---
"@qajitsu/core": minor
"@qajitsu/report": minor
"@qajitsu/agents": minor
"@qajitsu/verifier": minor
"@qajitsu/guard": minor
"@qajitsu/cli": minor
---

Map as planner input (REQ-OBS-08): `qj plan` builds the application map of every past run and stores the part around the change in `map/around.json` (touched screens and endpoints, never tested ones next to them, transitions from or to them). The planner sees it as untrusted data and may add regression cases citing `{kind: map, id}`, checked by code; the guard protects `map/`. New `mapAroundChange` in the report package and `collectAppMap` behind `qj map`.
