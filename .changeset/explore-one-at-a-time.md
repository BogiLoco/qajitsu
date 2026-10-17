---
"@qajitsu/cli": patch
---

Explorers perform actions one at a time when the model asks for several in one turn (REQ-EXEC-15/AC9). Before, the
concurrent calls shared one action id, their outputs mixed in the live view and evidence of one was lost.
