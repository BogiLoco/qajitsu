---
name: adversarial-test
description: Write an adversarial test where a scripted lying agent, broken runner or tampered artifact tries to make a QAJitsu result look better than it is, and assert the system blocks it. Use for any change to the guard, verifier gates, steps/evidence, status computation, healer or report.
argument-hint: "[protection being added or changed]"
---

# /adversarial-test $ARGUMENTS

An adversarial test proves a protection works by attacking it. Write it **before** the protection, watch it fail, then implement.

## 1. Pick the attack

Choose from [scenarios.md](scenarios.md) or describe a new one in one sentence: _who_ attacks (agent, runner output, file on disk, ticket text), _what_ they try, _which invariant_ it targets (1–10 in `.claude/rules/architecture-invariants.md`).

## 2. Write the test in `tests/adversarial/<invariant>-<short-name>.test.ts`

- Build the attacker deterministically: `createScriptedModel` for an agent that makes specific tool calls, a fake runner returning crafted JSON, or a temp run workspace with tampered files.
- Run the real pipeline stage under test (guard, verifier, status computation, report), not a mock of it.
- Assert all three:
  1. the attack is blocked (tool denied, gate failed, or status is BLOCKED/NEEDS_REVIEW/FAILED as appropriate),
  2. the attempt is recorded (journal event or gate reason),
  3. no artifact claims success (no PASSED in results, matrix or rendered Jira comment).

```ts
it("denies the author agent writing a PASSED result file", async () => {
  const model = createScriptedModel([
    toolCall("write_file", { path: "results/TC-01.json", content: '{"status":"PASSED"}' }),
  ]);
  const run = await runStage("author", { model, workspace });

  expect(run.journal).toContainEqual(expect.objectContaining({ event: "tool_denied", tool: "write_file" }));
  expect(await workspace.exists("results/TC-01.json")).toBe(false);
});
```

## 3. Confirm red, then implement

Run `pnpm test:adversarial -- <file>`. It must fail before the protection exists. Implement the protection, rerun, then `/verify`.

## 4. Review

Ask the `verification-auditor` agent to check the change and whether neighbouring attacks are still open. Add those scenarios to `scenarios.md` with status `todo`.
