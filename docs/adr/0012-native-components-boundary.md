# 0012. Rust only for trust-critical and heavy-processing components

- Status: Proposed
- Date: 2026-10-21
- Related: REQ-NFR-13, REQ-NFR-11, REQ-VER-15, REQ-VER-21, ADR-0001

## Context

QAJitsu is a TypeScript monorepo (ADR-0001). Measured time goes mostly to model calls, environments and test
execution. A few components handle large volumes of evidence, enforce invariants at system level or must be
verifiable independently of the code that produced the evidence.

## Decision (proposed)

One shared Rust library (hashing, Merkle tree, manifest, signatures, masking and secret scanning, image comparison),
used from Node, from the verifier (CLI and WebAssembly) and from the worker; optionally a Rust egress proxy and
sandbox, and a code-context indexer over MCP. Everything else stays in TypeScript.

Any further move to Rust needs measurements from REQ-NFR-11 that show a real bottleneck.

## Consequences

- A second toolchain in CI, cross-language tests on shared fixtures, signed native binaries for six platform targets.
- A stronger audit story through an independent implementation of the checks.
