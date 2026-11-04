---
"@qajitsu/steps": minor
"@qajitsu/verifier": minor
"@qajitsu/agents": minor
"@qajitsu/adapter-runner-api": minor
---

GraphQL subscriptions over WebSocket (REQ-EXEC-48/AC2).

- **Specs:** `api.subscribe(query, variables, { path })` opens a WebSocket that speaks graphql-transport-ws. Every
  pushed payload is a stream message (`messages.0.data.priceChanged.price`).
- **Checks:** the verifier checks the subscription's query and every payload against the schema, like a query's.
- **Blocked:** a step planned as GraphQL that sends its query without `api.graphql()` or `api.subscribe()`.
