---
"@qajitsu/core": patch
---

The audit archive's retention counts from the last entry of each archived journal, not from the file's time on disk
(REQ-OBS-05/AC2). Before, `qj gc` compared the file's real modification time with its clock, so a journal copied
into the archive later than its run ended was kept too long, and the retention test depended on the day it ran.
