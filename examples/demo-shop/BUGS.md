# Seeded bugs

Each bug is off by default and switched on with an environment flag. Tests and benchmarks (REQ-NFR-04, REQ-LLM-06)
assert that the targeting case ends FAILED with the flag on and PASSED with it off. Ids are stable; never reuse one.

| Id     | Flag                             | Area      | Type   | Symptom                                                                  | Ticket fixture | Stage |
| ------ | -------------------------------- | --------- | ------ | ------------------------------------------------------------------------ | -------------- | ----- |
| BUG-01 | `BUG_CART_TOTAL_ROUNDING`        | cart      | api    | Cart total rounds each line before summing (off by 0.01 for 3 × 0.335)   | DEMO-1         | 3     |
| BUG-02 | `BUG_ORDER_ACCEPTS_NEGATIVE_QTY` | orders    | api    | `POST /orders` accepts `quantity: -1` with 201 instead of 422            | DEMO-2         | 3     |
| BUG-03 | `BUG_AUTH_EXPIRED_TOKEN_OK`      | auth      | api    | Expired token still returns 200 on `GET /me`                             | DEMO-3         | 3     |
| BUG-04 | `BUG_DISCOUNT_STACKS`            | cart      | api    | Two discount codes stack although only one is allowed                    | DEMO-1         | 3     |
| BUG-05 | `BUG_CHECKOUT_BUTTON_DISABLED`   | web       | web    | Checkout button stays disabled after accepting terms                     | DEMO-4         | 5     |
| BUG-06 | `BUG_PRICE_FORMAT_LOCALE`        | web       | web    | Price shown as `12.5` instead of `12,50 zł` in the `pl-PL` locale        | DEMO-4         | 5     |
| BUG-07 | `BUG_SILENT_500_TOAST`           | web       | mixed  | API returns 500 but UI shows the success toast                           | DEMO-5         | 5     |
| BUG-08 | `BUG_ANDROID_BACK_EMPTIES_CART`  | mobile    | mobile | Android back button from checkout empties the cart                       | DEMO-6         | 8     |
| BUG-09 | `BUG_AVATAR_LIMIT_TOO_LOW`       | profile   | web    | The avatar upload refuses PNGs over 100 KB instead of 2 MB               | DEMO-7         | later |
| BUG-10 | `BUG_EXPORT_DROPS_LAST_ROW`      | products  | web    | The CSV export misses the last product                                   | DEMO-7         | later |
| BUG-11 | `BUG_3DS_RESULT_IGNORED`         | payment   | web    | After 3-D Secure in the pop-up the payment page stays Pending            | DEMO-8         | later |
| BUG-12 | `BUG_DRAG_WRONG_COLUMN`          | board     | web    | A card dropped on Done lands in In progress                              | DEMO-9         | later |
| BUG-13 | `BUG_RATING_OFF_BY_ONE`          | reviews   | web    | Clicking a star (in Shadow DOM) records one star less, also in the chart | DEMO-9         | later |
| BUG-14 | `BUG_DELETE_IGNORES_CANCEL`      | addresses | web    | Cancelling the delete confirmation still deletes the address             | DEMO-10        | later |
| BUG-15 | `BUG_OFFER_NEVER_EXPIRES`        | offer     | web    | The Christmas offer still shows active after its end time                | DEMO-10        | later |
| BUG-16 | `BUG_OFFLINE_NOTES_LOST`         | notes     | web    | Notes written offline are dropped instead of saved when back online      | DEMO-11        | later |

Rules:

- A bug must be detectable through behaviour described in its ticket, not by reading the flag.
- Ticket fixtures never mention the bug; they describe the intended behaviour.
- Benchmarks report detection rate per bug and false FAILED with all flags off.
