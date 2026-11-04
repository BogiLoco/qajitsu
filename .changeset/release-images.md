---
"@qajitsu/cli": patch
---

Signed release images (REQ-GEN-09):

- Every release is published as `ghcr.io/bogiloco/qajitsu` for amd64 and arm64, built from the published packages.
- Every dependency is pinned to the versions this repository tests.
- Each image ships with an SBOM and build provenance, is signed and is verified after the push.
- `docker run --rm ghcr.io/bogiloco/qajitsu demo` runs the demo-shop flow offline.
- A run in the image records it by digest, marked as declared by whoever started the container (`-e QAJITSU_IMAGE_DIGEST`), and says so when the digest was not given. `qj doctor` shows the same line.
