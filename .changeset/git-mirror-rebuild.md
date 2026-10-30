---
"@qajitsu/core": patch
---

A damaged git mirror in the project's cache (partly removed, e.g. by a cleaner of temporary folders, or with its
objects missing) is cloned again from the origin instead of failing `qj fetch` with `GIT_FAILED`. When the origin cannot
be reached, a healthy mirror is kept for the next try (REQ-CTX-04/AC1).
