# ADR-0015: Plugin guard in the process

- Status: accepted
- Date: 2026-11-03
- Related: REQ-GEN-11, REQ-GEN-12, REQ-GEN-14, ADR-0011, INV-2, INV-8, INV-10, INV-12

## Context

Since REQ-GEN-11 every integration is a plugin installed on demand. Plugins run in QAJitsu's own Node process,
against the installation's own core, steps, guard and verifier. Nothing technically stops their code from opening
sockets, starting processes, reading `process.env` or writing files.

REQ-GEN-11/AC9 asked that a plugin reach only the hosts of its manifest "that are also on the environment allowlist"
and never write results or evidence. That cannot hold as written:

- Runner plugins write results and evidence by design (INV-2).
- An integration's host (Jira, GitHub, Vault) is never on the environment allowlist, which lists the application
  under test.

A separate process per plugin under Node's permission model would isolate them fully. It would also mean rebuilding
the wiring of every adapter around IPC.

## Decision

Plugins stay in the process, and the guard holds each one to its manifest.

- **Code checked against permissions.** At install, and again when an installed plugin is loaded, the plugin's own
  files are scanned. Its imports of Node's modules, global `fetch` and reads of `process.env` must be covered by its
  `permissions`, and it must not refer to `plan.approved.yaml`. A violation refuses the plugin with the reason. The
  permissions are:
  - `network`: `net`, `http`, `https`, `http2`, `tls`, `dgram`, `dns`, global `fetch`;
  - `exec`: `child_process`, `worker_threads`, `cluster`;
  - `filesystem`: `fs`, `fs/promises`;
  - `environment`: `process.env`.

  A contract test runs the same check on every adapter package of this repository, so a manifest that understates
  what its code does fails CI.

- **HTTP calls guarded.** Integration plugins get a guarded `fetch`. It allows only the hosts of the manifest (exact
  names or `*.domain`) and the origins the project configures for that plugin (`config` in the manifest): the Jira
  base URL, the code host, the Vault address. Any other host is refused with the plugin and the host named.
- **Runners and environments.** Their requests stay limited to the environment and its allowlist, by the runner's own
  `allowedOrigins` and the browser's request routing, as before.
- **Results and evidence.** Only runner plugins record results and evidence, through the core's evidence store and
  the run's result files (INV-2). Other plugins never get the run's workspace paths.

## Consequences

- A manifest has to say what its code does. The first scan found five understated manifests, which this change
  corrects:
  - `publish-jira` reads attachment files;
  - `env-remote` runs login scripts and reads the environment;
  - `env-compose`, `runner-api` and `runner-mobile` read the environment for the processes they start.
- The guarantee covers the plugin's own code, not the third-party packages it depends on. Those are pinned, verified
  against their published checksums and installed without scripts (REQ-GEN-11/AC3). The registry's verification and
  review of manifests (REQ-GEN-12/AC7) covers the rest.
- A full sandbox, with a separate process per plugin, stays possible later behind the same manifest. It would need a
  new ADR.
