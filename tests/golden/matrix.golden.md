**4 cases: 2 PASSED, 1 FAILED, 1 BLOCKED**

| TC | Title | Requirement | Type | Status | Steps OK | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| TC-01 | Adding a product returns 201 and recalculates the total | AC-1 | API | PASSED | 1/1 | req/resp × 1 |
| TC-02 | Cart shows the new total in the UI | AC-1 | WEB | FAILED | 1/2 | 2 screenshots, video, trace |
| TC-03 | Quantity limit of 99 per item | AC-2 | API | PASSED | 2/2 | req/resp × 2 |
| TC-04 | Add to cart in the Android app | AC-3 | MOBILE | BLOCKED | 0/3 | emulator log |
