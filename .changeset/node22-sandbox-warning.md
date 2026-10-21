---
"@qajitsu/cli": patch
---

`qj explore --cli` on Node.js 22: the tool's output no longer starts with Node's "EnvHttpProxyAgent is experimental"
warning, which the sandbox's proxy setting caused; other warnings of the tool are kept.
