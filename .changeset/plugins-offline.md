---
"@qajitsu/cli": minor
---

Offline installations get their plugins from the bundle (REQ-GEN-11/AC6). `qj setup --download <dir>` installs the
plugins the project needs, with their dependencies and checked against their published checksums, into
`<dir>/plugins/`. `qj setup --from <dir>` copies them into the QAJitsu home without any network, after checking each
manifest and core API range again.
