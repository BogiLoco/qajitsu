---
"@qajitsu/verifier": minor
"@qajitsu/cli": minor
---

Numbers written as text in plan expectations (`total: "1.01"`) are converted by code when the OpenAPI document says
the field is a number or an integer; `qj plan` lists every conversion and the planner is not sent back for them
(REQ-PLAN-12).
