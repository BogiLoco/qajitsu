---
"@qajitsu/cli": patch
---

The adapters of a project are built through the plugin loader (REQ-GEN-11/AC2): the Jira ticket source, the GitHub and
GitLab code hosts and the Xray, Zephyr and TestRail case sources each come from their plugin, and a missing one stops
the command with the command that installs it.
