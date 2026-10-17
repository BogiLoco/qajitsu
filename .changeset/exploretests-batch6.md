---
"@qajitsu/verifier": minor
"@qajitsu/cli": patch
---

A spec for a case that runs as a test account must log in as it (`api.as(...)` or `ui.as(...)`); one that never does
is refused and sent back to the author like a missing `verify()`. A local author wrote `api.get("/cart")` for a case
with `data.user`, every call got 401, and the cases ended FAILED as if the cart were broken. The demo shop's OpenAPI
documents login and the 401 of every protected operation, and the plan check also reads `security`.
