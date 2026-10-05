---
"@qajitsu/core": minor
"@qajitsu/agents": minor
"@qajitsu/cli": minor
---

The author can explore the application through MCP servers (`mcp.servers`, e.g. Playwright MCP) to find selectors.
Servers start without a shell, with a minimal environment, in a temporary folder outside the run; only the listed
tools are offered, every call goes through the guard and the journal, `url` inputs are checked against the
environment allowlist, images are not stored, and exploration never produces results or evidence. New dependency:
`@ai-sdk/mcp` (the AI SDK's MCP client, already part of the stack).
