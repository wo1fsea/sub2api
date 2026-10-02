# Restrained Neubrutalism

Our single custom appearance follows the default homepage at https://openjev.com/: warm paper (`#f7f6f0`), near-black ink (`#171715`), fine straight borders, flat panels, heavy headings, monospace labels and a small amount of fluorescent lime (`#d4ff3f`). Primary actions have a 3px hard offset shadow. Dense tables and metrics stay flat; dialogs use a small hard shadow. Pink decoration and colored metric rules have been removed.

The displayed Chinese name is **克制的新粗野主义**. `neubrutalism` and `original` are the two supported skin IDs. `sub2api.skin` defaults to `neubrutalism`; an existing `clash` preference is migrated automatically, including storage events from an older tab. An unknown ID falls back to original. Light/dark mode remains an independent preference. Original mode retains the upstream appearance.

Grayscale chart/icon behavior is preserved. Model-distribution and spending-ranking doughnuts use twelve diagonal hatch patterns and matching legend swatches. Trends use gray lines and dash styles. Provider, status and payment utility colors resolve to neutral tokens; error/warning badges use dashed borders while their labels retain the meaning. Fixed-color SVGs and canvases are rendered in grayscale. User-uploaded images and third-party embedded payment/captcha content are not rewritten.

Dashboard text has only two tones: primary ink and secondary `#4a4a4a`; dark mode uses `#f4f4f4` and `#bcbcbc`. Both levels exceed 7:1 contrast on their surfaces. The slightly warm paper is intentional; utility colors and chart pixels remain neutral.

## Implementation

| Location | Responsibility |
| --- | --- |
| `frontend/src/composables/useSkin.ts` | Preference, migration, early application and cross-tab synchronization |
| `frontend/src/styles/neubrutalism-skin.css` | Scoped appearance and responsive layout |
| `frontend/tailwind.config.js` | Shared token palette with original-color fallbacks |
| `frontend/src/composables/useChartTheme.ts` | Neutral charts, hatch patterns and independent dark mode |
| `frontend/src/components/common/SkinSwitcher.vue` | Accessible appearance toggle |

The shared shell, inputs, buttons, tables, login, compact home, key usage and dashboard inherit this appearance. Specialized routes are not all independently redesigned.

## Isolated verification

From `frontend`, run `node scripts/preview-skin.mjs --port 18382` and open `http://127.0.0.1:18382/admin/dashboard`. The loopback-only preview uses synthetic data, disables backend proxies and rejects writes with 405. It does not read production credentials and cannot prove real gateway availability.

Verification covers desktop, the user's 983x895 viewport, 390px/320px mobile, independent dark mode, original fallback, legacy preference migration, cross-tab synchronization, keyboard activation, hatch detail, two text tones, date menus and an unsaved user dialog. Review screenshots separately from dimensions and color measurements. Unit tests, typecheck, lint and production build complement browser checks.

Production cutover is a separate step: a real short Responses request must complete on the exact candidate before moving the entry, followed by another request through the unchanged HTTPS address. Retain the previous healthy instance and its static assets for rollback. A client may reconnect; this workflow does not replay POST requests or promise continuation of a partially delivered stream.
