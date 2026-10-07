---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/report": minor
"@qajitsu/agents": minor
"@qajitsu/cli": minor
---

Locale runs (REQ-EXEC-14): project `locales` with time zones; plan cases list their locales and give per-locale expected values (`expect.by_locale`, only planned keys); each locale runs with the plan resolved for it (`planForLocale`), the browser locale and time zone and an `Accept-Language` header; the case is PASSED only if every locale passed; reports show the status per locale.
