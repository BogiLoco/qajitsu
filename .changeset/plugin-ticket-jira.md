---
"@qajitsu/cli": patch
"@qajitsu/adapter-ticket-jira": minor
---

The Jira ticket source (Cloud and Data Center) is a plugin (REQ-GEN-11/AC1): `qj plugin add ticket-jira`; `qj setup` installs it for a project with `jira.type: cloud` or `datacenter`. Tickets from files stay in the core. The adapter takes `@qajitsu/core` as a peer dependency; the TicketSource contract runs against the installed plugin.
