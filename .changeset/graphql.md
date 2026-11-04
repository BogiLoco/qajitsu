---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/verifier": minor
"@qajitsu/agents": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/cli": minor
---

GraphQL testing (REQ-EXEC-48).

- **Schema:** `repos.<alias>.graphql` names the schema of the analysed commit: an SDL file in the repository, or an
  endpoint path such as `/graphql`, which is introspected on the test environment.
- **Planning:** the planner sees its operations. A plan step names `graphql: { operation: "Query.product" }`, and a
  draft that cites an operation the schema does not have goes back to the planner.
- **Specs:** they call `api.graphql(query, variables)`.
- **Checks after each attempt:**
  - an `errors` array where the plan expects data fails the step, even with HTTP 200;
  - data that does not fit the schema's types fails it too;
  - a query that does not fit the schema, or skips the planned operation, makes the case BLOCKED as the spec's error.
- **Demo shop:** a GraphQL endpoint with DEMO-18, BUG-24 (the price as text) and BUG-25 (an error next to the data).
