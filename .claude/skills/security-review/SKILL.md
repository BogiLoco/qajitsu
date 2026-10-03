---
name: security-review
description: Security checklist for QAJitsu changes - secret flow and masking, evidence and Jira publishing, shell and Docker execution, URL allowlists and SSRF, prompt injection from ticket or PR text, MCP servers, dependencies and file paths.
---

# QAJitsu security checklist

Go through every section that the change touches. For each item answer yes / no / n.a. with file:line evidence.

## Secrets

- [ ] Secret values come only from `SecretProvider` and are registered with the masker on resolve.
- [ ] No secret reaches: LLM prompts, tool arguments shown to the model, logs, errors, evidence, report.html, Jira comment or attachments, PR/MR comments, fixtures.
- [ ] Generated `.env` files are 0600, live in the run workspace, and are deleted on every exit path (success, failure, SIGINT).
- [ ] Masking covers the new data: headers, JSON paths, query strings, cURL rendering, screenshots of pages showing tokens (avoid screenshots of settings pages).
- [ ] Publish gate secret scan runs over every artifact that leaves the machine.

## Execution

- [ ] `execa(cmd, args)` with array args; no `shell: true`; no values from tickets, branch names or PR titles interpolated into commands.
- [ ] Branch names, ticket keys and paths are validated (regex / Zod) before use in git, docker or file paths.
- [ ] Docker resources are labelled and cleaned; containers do not run privileged; no host network unless required and documented.

## Network

- [ ] Every outbound URL is checked against the environment allowlist (runners, agents, MCP browser, adapters).
- [ ] URLs from tickets or config cannot target internal metadata endpoints or production (SSRF).
- [ ] TLS verification stays on.

## Prompt injection

- [ ] Ticket text, PR descriptions, review comments, web pages and MCP results are passed to the model as clearly delimited data, never as instructions.
- [ ] No content from those sources can change which tools an agent has, its allowlist, or the stage it runs.
- [ ] Guard decisions do not depend on model output.

## Supply chain

- [ ] New dependencies justified; no unexpected `postinstall`; licence compatible (Apache-2.0 / MIT / BSD / ISC).
- [ ] MCP servers referenced in docs or config pinned to a version in production guidance.

## File system

- [ ] All run workspace paths resolved under the workspace root (no `..` escape, symlinks checked).
- [ ] Cleanup cannot delete outside the workspace or remove resources without QAJitsu labels.
