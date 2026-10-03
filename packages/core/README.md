# @qajitsu/core

Statuses, identifiers, typed errors, project configuration schema and the adapter interfaces every other package builds on. Core depends on no adapter and no LLM provider (invariants 11 and 12).

| Module                     | Requirements                       |
| -------------------------- | ---------------------------------- |
| `status.ts`                | REQ-VER-01, REQ-VER-06, REQ-CI-04  |
| `identifiers.ts`           | REQ-CTX-01, REQ-WS-01              |
| `errors.ts`                | REQ-NFR-01                         |
| `config/project-config.ts` | REQ-GEN-01, REQ-CTX-02, REQ-CFG-03 |
| `interfaces/`              | REQ-GEN-02                         |

Next in this package (roadmap stage 1): run workspace and orchestrator state machine.
