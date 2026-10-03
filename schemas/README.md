# Published JSON Schemas

Generated from the Zod schemas in `@qajitsu/core` (`z.toJSONSchema`) so editors can validate files and other tools can
read QAJitsu output. Never edited by hand.

| File                     | Source                | Requirement | Stage |
| ------------------------ | --------------------- | ----------- | ----- |
| `qa.project.schema.json` | `ProjectConfigSchema` | REQ-GEN-01  | 1     |
| `plan.schema.json`       | plan schema           | REQ-PLAN-02 | 2     |
| `results.schema.json`    | case results          | REQ-VER-02  | 3     |
| `manifest.schema.json`   | evidence manifest     | REQ-VER-05  | 3     |

VS Code maps `qa.project.yaml` to the project schema in `.vscode/settings.json` once the file exists.
