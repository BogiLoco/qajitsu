---
name: model-evals
description: Run and compare QAJitsu model benchmarks on demo-shop with real LLMs (cloud, LiteLLM or Ollama) - detection rate, false failures, BLOCKED rate, time and cost per role. Costs money; run only on explicit request.
argument-hint: "[provider/model ...] [--role author|planner|auditor]"
disable-model-invocation: true
---

# /model-evals $ARGUMENTS

Benchmarks use real models and real money. Confirm the models and the case subset with the user before starting if they are not given above.

1. Check prerequisites with `pnpm qajitsu doctor --models`: provider keys resolvable, Ollama reachable for local models, capability profile satisfies the role (tools, structured output, vision for auditor).
2. Run `pnpm bench --model <provider/model> [--role <role>] [--cases <subset>]` per model. Use the same case subset and the same scripted settings for every model so results are comparable.
3. Results land in `bench/results/<date>-<model>.json`. Do not edit them.
4. Report a table per role:

| Model | Detected seeded bugs | False FAILED | BLOCKED | Plan acceptance (judge) | Median time | Cost |
| ----- | -------------------- | ------------ | ------- | ----------------------- | ----------- | ---- |

5. Interpret honestly: small case counts mean wide uncertainty; say so. A model that is cheap but raises BLOCKED a lot may still be the right choice for `summary`, not for `author`.
6. If a result should change defaults in `templates/qa.project.yaml`, propose it; do not change defaults in the same step.
