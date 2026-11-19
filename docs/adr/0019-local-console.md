# ADR-0019: The local console reads the run files and trusts only the browser that opened it

- Status: accepted
- Date: 2026-11-18
- Related: REQ-WEB-01, REQ-WEB-07, REQ-CI-07, REQ-OBS-09, REQ-PRJ-10, INV-1, INV-6, INV-8

## Context

REQ-WEB-01 asks for a console in the browser over the same files the CLI writes; the plan review (REQ-WEB-07) and the
thin CI client (REQ-CI-07) build on it. A web server on a developer's machine is reachable by every web page the
person opens (a page can send requests to `127.0.0.1`, and with DNS rebinding read the answers) and by every other
user of the machine. What it shows includes evidence, plans and results; later it will approve plans.

## Decision

- **Read the files, compute nothing.** The console reads `run.json`, the reports, the evidence manifest and the plan
  files the CLI wrote. A status is the one the run computed and stored (INV-1, INV-6); there is no second code path
  that could disagree with the CLI. Actions (REQ-WEB-01/AC3) will call the same functions as the CLI commands, with
  their rules.
- **One machine, one person.** It listens on 127.0.0.1 only. A request must name `127.0.0.1:<port>` or
  `localhost:<port>` as its host, so a rebound domain is refused (421). Everything lives under a random path:
  cookies ignore ports, and a cookie scoped to that path is never sent to another server on 127.0.0.1 (the application
  under test, a dev server). `qj console` prints a start address with a random token that signs in one browser once;
  that browser gets a session cookie of its own (HttpOnly, SameSite=Strict, the path, a name with the port, 12 hours),
  so the address in a browser history or a terminal log is worth nothing afterwards. A page of another site cannot
  send the cookie, another user of the machine does not have it.
- **Pages run nothing.** Console pages are rendered on the server with every value escaped and served with a content
  security policy that allows no script, no framing and nothing from elsewhere. Run files (the report, a page the
  application under test returned, an SVG) are served with `sandbox`: they cannot run script or reach the console's
  origin or cookie.
- **Only what a run publishes anyway.** Files come from a run's `report/` and `evidence/` only: the folder must be a
  real folder inside the run (not a link), the file must resolve inside it and is opened without following a link;
  the journal, `env/`, `repos/` and `checks/` are never served, and no other page can frame a run file.
- **No framework, no new dependency.** `node:http` and server-side HTML, like `qj watch` and the evidence viewer; the
  pages work without JavaScript.

## Consequences

- Changing actions (approve, revise) add a CSRF check on top of the cookie (an origin check and a form token) in the
  plan review pull request.
- A team that wants a shared console needs the hosted control plane (REQ-SCALE-01), with real accounts; the local
  console is deliberately single-user.
- Live updates without JavaScript are limited; the live run view (REQ-WEB-05) may add a small script from the console
  itself, still under the policy (no inline script, no other origin).
