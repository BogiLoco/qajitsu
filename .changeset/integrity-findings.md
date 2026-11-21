---
"@qajitsu/verifier": patch
"@qajitsu/guard": patch
---

Two integrity fixes found by mutation testing. A failure seen in one attempt is no longer hidden by a retry reported
as skipped: the case is FAILED, not NOT_RUN (REQ-VER-02/AC4). The plugin code check (REQ-GEN-11/AC9) now parses a plugin's code with TypeScript instead of reading it line by line,
so code after a comment or a type-only import on the same line, a template literal that looks like a comment, or a
minified bundle behind a license banner can no longer hide a module from the permission check. It also covers more:
`module.require`, every `x.require`, `require.call` and `require.apply`; `node:module`, `vm`, `inspector`, `wasi`,
`repl`, `v8`, native addons, modules from a URL or an absolute path, `eval` and `Function` (also held or reached as
`.constructor`), `Module._load`, and `process.getBuiltinModule` with every other `process` property but a few harmless
ones need `exec`; code written into strings is still read as before; `node:sqlite` needs `filesystem` and `node:process` `environment`; `process` or the global object passed on,
or `.process.env` read from any object, counts as all it could reach; a file that does not parse or has HTML-like
comments is refused. A plugin that used one of these without the permission is now refused at install and load.
