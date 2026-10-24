# QAJitsu documentation

| Document                                               | What it is for                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [requirements/](requirements/README.md)                | **Source of truth**: numbered requirements (`REQ-AREA-NN`) with acceptance criteria and status          |
| [roadmap.md](roadmap.md)                               | Ten build stages, "done when" criteria, requirements per stage (generated)                              |
| [STATUS.md](STATUS.md)                                 | Where the project is right now                                                                          |
| [architecture/overview.md](architecture/overview.md)   | Components, agents, run workspace, statuses                                                             |
| [adr/](adr/)                                           | Architecture decision records (`ADR-nnnn`)                                                              |
| [glossary.md](glossary.md)                             | Terms used across code and docs                                                                         |
| [guides/getting-started.md](guides/getting-started.md) | Set up the repo and make a first change                                                                 |
| [guides/certificates.md](guides/certificates.md)       | Audit trail, signed test certificates, their format and what they prove                                 |
| [guides/jira-workflow.md](guides/jira-workflow.md)     | Status mapping, transitions after a run, plan approval by ticket comment, one run per ticket            |
| [guides/web-actions.md](guides/web-actions.md)         | Web actions and checks: uploads, downloads, frames, pop-ups, drag and scroll, Shadow DOM, dialogs, time |
| [plan.md](plan.md)                                     | Original planning document (Polish): rationale, alternatives, risks                                     |

For contributors and AI agents: the binding rules are in [`CLAUDE.md`](../CLAUDE.md) and [`.claude/rules/`](../.claude/rules/).
Every change references the requirement ids it implements; see [requirements/README.md](requirements/README.md#working-with-requirements).

Planned later (stage 9): CLI reference (`docs/cli/`), configuration reference, adapter guide and a documentation site.
