# Hatch chart verification

Preview: `node scripts/preview-skin.mjs --port 18382`, then `/__skin/charts`.
Only synthetic GET fixtures; backend proxies and writes remain disabled. This entry is not imported by the production application.

| Claim / control | Functional check | Visual state |
| --- | --- | --- |
| Model, group, endpoint and user doughnuts use matching hatch legends | Compare values/order; change metric and endpoint source | Light/dark, original return, table/card fit |
| Ops error categories preserve SLA counts and stable category patterns | Missing categories, detail-button events | Ring boundaries and legend patterns |
| Latency histogram and payment bars use diagonal fills | Preserve bucket counts and currency-relative widths | Light/dark, original return |
| Ops, monitor, account and revenue trends have neutral dash-separated lines | Preserve axes, series values, legend toggles and tooltip units | No solid area, readable labels/tooltip in both modes |
| Hatch palette is reused | Multiple mounts, light-dark-light, remount; failed allocation recovers | Both palettes retain contrast |
| Usage and remaining-capacity bars retain their widths | Existing component tests; browser values 0/45/100/120 and remaining 15 | Diagonal CSS tile, zero has no visible border/minimum width |
| Stateful appearance controls | Switch original/custom and light/dark in both directions | Original colored charts restored; custom hatches restored |
| Empty/loading controls | Select states and return to data | No stale plot or clipped placeholder |

Exploratory cases: more than twelve categories with long endpoint names; switching source/metric/theme while populated and after visiting another chart section. Check desktop and smaller viewport independently, record actual observed dimensions, and inspect screenshots separately from numeric overflow checks.

Release checks remain separate: exact-image smoke, fresh data restore, static-resource compatibility, real candidate Responses completion, hot switch and another completion through the unchanged HTTPS address.

## Observed on 2026-10-03

Chrome preview inspected at actual 1415x814, 983x895, 390x844 and 320x844. Light/dark and original/custom round trips, fourteen categories, endpoint source/metric changes, empty/loading returns, user refresh, Ops detail events and account modal open/load/close passed. Numeric checks showed no settled page overflow; narrow distribution tables deliberately scroll internally. Screenshots were inspected separately. The Ops legend stays inside its card. Both account axes and monitor line legends remain visible.

Full frontend suite: 2612 passed, 0 failed. Consumer tests preserve distribution order/values, missing-category pattern identity, payment currency ratios and trend axes/values. Theme tests verify cache reuse across instances/modes/remount and failed-allocation recovery. Download, zoom gestures and every tooltip hover were not newly exercised in the browser; their existing tests do not constitute a new visual check. Screenshots and logs stay ignored/local.
