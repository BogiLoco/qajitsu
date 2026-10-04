#!/usr/bin/env bash
# Pipeline steps of QAJitsu, shared by the GitHub Action, the GitLab template and Jenkins (REQ-CI-01, REQ-CI-03).
#
#   qajitsu-ci.sh plan <TICKET>   fetch (or reuse the run for /qa revise), plan, post the plan to Jira and the PR/MR
#   qajitsu-ci.sh run  <TICKET>   approve (a person, or reuse an approved plan), run, export artifacts, comment
#
# Environment:
#   QJ                 command to call QAJitsu (default: qajitsu)
#   QA_CHANGE          PR/MR URL for the comment and the status check (optional)
#   QA_REFS            extra fetch arguments, e.g. "--ref shop=feature/x" (optional)
#   QA_REVISE          reviewer instruction from "/qa revise <text>": a new plan version of the latest run
#   QA_APPROVER        who approved (protected environment reviewer, manual job user, /qa approve author)
#   QA_VERSION         plan version the reviewer approved (/qa approve v<N>); default: the latest
#   QA_REUSE           "true": reuse the latest approved plan if the ticket did not change (new commits)
#   QA_ENV             environment profile; QA_BUILD=true builds the app from the worktree instead
#   QA_ARTIFACTS       artifact folder (default: qa-artifacts)
# Exit code of "run" is the run's: 0 passed, 1 failed, 2 blocked/needs review, 3 error (REQ-CI-04/AC1).
set -euo pipefail

QJ="${QJ:-qajitsu}"
step="${1:?usage: qajitsu-ci.sh plan|run <TICKET>}"
ticket="${2:?ticket key missing}"
artifacts="${QA_ARTIFACTS:-qa-artifacts}"
comment() { if [ -n "${QA_CHANGE:-}" ]; then $QJ ci comment "$ticket" --change "$QA_CHANGE" || true; fi; }

# Run folders must come from this pipeline (artifacts, caches), never from the checked-out code: a change
# could otherwise commit a forged "approved" run.
if [ -n "${QAJITSU_WORKSPACE:-}" ] && [ -n "$(git ls-files -- "$QAJITSU_WORKSPACE" 2>/dev/null | head -n 1)" ]; then
  echo "QAJITSU_WORKSPACE ($QAJITSU_WORKSPACE) contains files tracked by git; refusing to use it" >&2
  exit 3
fi

case "$step" in
  plan)
    if [ -n "${QA_REVISE:-}" ]; then
      $QJ plan "$ticket" --revise "$QA_REVISE"
    else
      # shellcheck disable=SC2086 # QA_REFS holds several arguments on purpose
      $QJ fetch "$ticket" ${QA_REFS:-}
      $QJ plan "$ticket"
    fi
    $QJ ci publish-plan "$ticket" || echo "warning: the plan could not be posted to the ticket" >&2
    comment
    ;;
  run)
    if [ "${QA_REUSE:-false}" = "true" ]; then
      # shellcheck disable=SC2086
      $QJ fetch "$ticket" ${QA_REFS:-}
      $QJ approve "$ticket" --reuse-from latest --approver "${QA_APPROVER:-ci}"
    else
      # A person approved through the CI approval channel; QAJitsu never approves a new plan by itself.
      version=()
      if [ -n "${QA_VERSION:-}" ]; then version=(--version "$QA_VERSION"); fi
      $QJ approve "$ticket" --approver "${QA_APPROVER:?QA_APPROVER is required to approve a plan}" --confirm-open-questions ${version[@]+"${version[@]}"}
    fi
    args=()
    if [ "${QA_BUILD:-false}" = "true" ]; then args+=(--build); fi
    if [ -n "${QA_ENV:-}" ]; then args+=(--env "$QA_ENV"); fi
    set +e
    $QJ run "$ticket" ${args[@]+"${args[@]}"}
    code=$?
    set -e
    $QJ export "$ticket" --out "$artifacts" || true
    comment
    exit "$code"
    ;;
  *)
    echo "unknown step $step" >&2
    exit 3
    ;;
esac
