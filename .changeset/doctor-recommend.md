---
"@qajitsu/cli": minor
"@qajitsu/agents": minor
"@qajitsu/toolchain": minor
---

`qj doctor --recommend` (REQ-GEN-13): looks at the application's repository and recommends only the tools its tests
need. Code finds web front-ends, mobile projects, API descriptions, compose files and existing test suites, each with
its files; the analyst model turns them into a recommendation that code checks (only toolchain tools and a few
settings, each resting on a finding of the right kind). It shows download size and disk space, what is not installed
and why, and the `qj setup --only` command, and installs after a yes or with `--yes`. `--offline` recommends from the
findings alone. The toolchain manifest gains `diskBytes`.
