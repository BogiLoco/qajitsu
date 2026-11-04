#!/bin/sh
# Entry point of the release image (REQ-GEN-09): `demo` runs the offline demo-shop flow (AC5); anything else is a
# qajitsu command.
set -eu
if [ "${1:-}" = "demo" ]; then
  shift
  exec node /opt/qajitsu/demo/scripts/demo.mjs "$@"
fi
exec qajitsu "$@"
