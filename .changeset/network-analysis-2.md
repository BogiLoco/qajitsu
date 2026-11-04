---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/report": minor
"@qajitsu/cli": minor
---

Analysis of the recorded network traffic, AC3..AC7 (REQ-EVD-09).

Every web attempt writes `network-analysis.json`, and each finding names its entry in `network.har`. The report
lists the findings as observations, never as results:

- **Performance:** the number, size and slowest requests per step, with warnings from
  `observations.network.budget` or a case's `network_budget`.
- **Security:** tokens and personal data in URLs, mixed content, missing security headers, and cookies without
  `HttpOnly` or `Secure`.
- **Contract (opt-in):** with `observations.network.response_bodies.enabled`, the page's JSON responses are kept
  masked and size-limited, and checked against the OpenAPI description.
- **Changes since the last run of the same approved plan:** endpoints that appeared, disappeared or changed status
  or shape, and steps that became much slower.
