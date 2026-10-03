# QAJitsu documentation

| Document                                               | What it is for                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [requirements/](requirements/README.md)                | **Source of truth**: numbered requirements (`REQ-AREA-NN`) with acceptance criteria and status |
| [roadmap.md](roadmap.md)                               | Ten build stages, "done when" criteria, requirements per stage (generated)                     |
| [STATUS.md](STATUS.md)                                 | Where the project is right now                                                                 |
| [architecture/overview.md](architecture/overview.md)   | Components, agents, run workspace, statuses                                                    |
| [adr/](adr/)                                           | Architecture decision records (`ADR-nnnn`)                                                     |
| [glossary.md](glossary.md)                             | Terms used across code and docs                                                                |
| [guides/getting-started.md](guides/getting-started.md) | Set up the repo and make a first change                                                        |
| [plan.md](plan.md)                                     | Original planning document (Polish): rationale, alternatives, risks                            |

For contributors and AI agents: the binding rules are in [`CLAUDE.md`](../CLAUDE.md) and [`.claude/rules/`](../.claude/rules/).
Every change references the requirement ids it implements; see [requirements/README.md](requirements/README.md#working-with-requirements).

Planned later (stage 9): CLI reference (`docs/cli/`), configuration reference, adapter guide and a documentation site.
