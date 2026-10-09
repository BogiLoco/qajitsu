# @qajitsu/toolchain

Everything behind `qj setup` (REQ-GEN-06): the manifest of pinned tool versions and compatible ranges, what a project
needs, detection of the tools already on the machine, the setup plan, prechecks, resumable checksum-verified
downloads, installers, the record of what QAJitsu installed (`~/.qajitsu/toolchain/installed.json`), the setup lock,
smoke tests, offline bundles, and the environment QAJitsu passes to the processes it starts. Shell profiles are never
edited.

Every side effect goes through injected ports (`exec`, `download`, file system under a root), so the unit tests run
without network or real installs.
