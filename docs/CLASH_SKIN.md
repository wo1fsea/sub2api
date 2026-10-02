# Clash Skin Development

This branch adds one custom skin inspired by our Clash Traffic Panel. The latest direction is grayscale with sparse fluorescent accents, not the upstream's many semantic colors. The original Sub2API appearance remains available as a fallback. This is a frontend change, not a gateway, authentication, billing, or database change.

## Scope

The inspected local source already had light/dark mode, site name/logo settings, and a shared Tailwind palette. It did not have a multiple-skin registry. This branch deliberately adds only `clash` and `original`, not a collection of color presets or arbitrary CSS uploads.

The custom skin uses neutral gray/white surfaces (`#f4f4f4`, `#fdfdfd`), dark ink (`#181818`), fine borders, and square controls. Lime (`#d4ff3f`) is reserved for primary actions, the active skin toggle, selection, and small heading/metric rules. Pink (`#ee5ba6`) is limited to a small metric rule. Dark mode uses neutral black/gray surfaces, not blue-gray.

Success, warning, error, role, provider, payment, and link utility colors all resolve to neutral tokens in Clash mode. Text, icons, values, and business behavior remain unchanged; warning/error badges and invalid inputs use dashed borders. Model-distribution and spending-ranking doughnuts use diagonal hatches, with matching table swatches and thin segment outlines. Twelve patterns vary spacing, direction, and stroke width; larger datasets wrap the pattern sequence, and unavailable canvas contexts fall back to neutral fills. Trend charts keep neutral lines with different dash styles; group/endpoint distributions retain solid neutral fills. Scoped grayscale rendering also covers fixed-color SVG marks and specialized chart canvases, while model icons use contrasting ink in both modes. Branded payment icons and locale flags are neutralized. User-supplied images and third-party embedded payment/captcha content are not rewritten. The dense sidebar remains in place because Sub2API has substantially more navigation than the reference panel.

Dashboard typography has two levels rather than many utility grays: primary `#181818` / `#f4f4f4`, secondary `#4a4a4a` / `#bcbcbc` for light/dark modes. Values and body labels use primary ink; compact descriptions, units, table headings, chart legends, and axes use the secondary tone. Expanded date menus and input text follow the same rule. The date-range apply button has a neutral surface and outline so the text reset cannot produce dark text on a dark button.

The adaptation covers the shared shell, shared buttons/inputs/cards/tables, login, home, key usage, and the admin dashboard. The shared color layer applies across the app, but specialized pages are not all independently redesigned or visually certified.

## Implementation

| File | Responsibility |
| --- | --- |
| `frontend/src/composables/useSkin.ts` | Preference, safe IDs, early initialization, cross-tab synchronization |
| `frontend/src/components/common/SkinSwitcher.vue` | Fixed-size icon toggle with tooltip and pressed state |
| `frontend/src/styles/clash-skin.css` | Custom skin tokens and scoped component overrides |
| `frontend/tailwind.config.js` | CSS-variable palettes with the original values as fallbacks |
| `frontend/src/composables/useChartTheme.ts` | Reactive chart skin and dark-mode appearance |
| `frontend/src/main.ts` | Applies the skin before Vue mounts |

The root attribute is `data-skin="clash"` or `data-skin="original"`. Browser preference is stored as `sub2api.skin`. No saved preference defaults to Clash; an unknown saved ID falls back to original. Switching does not change the independent `theme` preference. Storage failure does not prevent this skin controller from applying a skin; other existing application startup code still requires browser storage.

Original mode removes the custom token scope, restoring the original Tailwind colors, radii, and styling. No dependency manifest or lockfile is changed.

## Isolated Preview

From `frontend`, with compatible Node and frontend dependencies installed:

```sh
node scripts/preview-skin.mjs --port 18381
```

Open `http://127.0.0.1:18381/admin/dashboard`. `/admin/users` provides a synthetic table record and `/login` provides a guest appearance preview.

This script binds only to loopback, disables all backend proxies, uses fixed synthetic fixtures, and rejects non-GET/HEAD API requests with HTTP 405. It never reads production configuration or credentials. An explicit environment banner identifies the preview. Unimplemented endpoints return 404; this is not a functioning production backend and cannot certify model calls, OAuth, billing, or database migrations.

The demo auth token has no authority outside this preview. Its session is staged only in this separate browser origin. The preview plugin is not imported by the production build.

## Verification

The QA inventory includes grayscale surfaces with sparse lime/pink accents, diagonal doughnut hatches with matching markers, two-tone dashboard text, original rollback, preference restoration, cross-tab updates, independent dark mode, keyboard operation, navigation, login, mobile menus, unknown stored IDs, and rejected writes. Additional interaction states include the spending-ranking view, expanded date-range menus and apply-button hover, locale dropdown, and an unsaved create-user dialog with its role selector. Screenshots must be reviewed separately from numeric fit checks.

```sh
node node_modules/vitest/vitest.mjs run
node node_modules/vue-tsc/bin/vue-tsc.js -b
node node_modules/vite/bin/vite.js build
node scripts/verify-skin.mjs
```

`verify-skin.mjs` requires Playwright and a Chromium browser. With shared tooling outside this repository, set `SUB2API_PLAYWRIGHT_MODULE` to that installed Playwright `index.mjs`. Set `SUB2API_SKIN_PREVIEW_URL` only to an isolated preview. The script requires a loopback URL and the `skin-preview` fixture version before testing; it makes a deliberately rejected write request and must not target production. Generated screenshots/reports live under ignored `frontend/tmp/`.

Validation on 2026-10-02:

- Focused skin/palette/chart/table/i18n/dashboard suite: 88 passed, including generated Tailwind utility fallback checks, hatch generation/fallback, ranked/unranked markers, and light/dark chart text with original rollback.
- Full frontend suite: 2110 passed, 2 failed. Both failures were reproduced on the unchanged base commit during the initial skin work: provider count in `ChannelMonitorView.grok.spec.ts` and missing test Pinia in `GroupsView.codexManifest.spec.ts`.
- Typecheck, production asset build, and lint of all changed JS/TS/Vue files passed. The copied pnpm layout required `NODE_PATH` to its existing `.pnpm/node_modules` for ESLint's transitive parser.
- Browser checks passed at desktop 1440px, the commented 983x895 viewport at 2x pixel density, and mobile 390px/320px, including light/dark, refresh, cross-tab sync, keyboard toggle, ranking, users navigation, expanded date-range menus, locale dropdown, unsaved create-user dialog, login, unknown-ID recovery, and rejected writes. No page-level horizontal overflow or clipped metric values was found in these states. Dashboard DOM text and input colors use exactly two tones, including expanded menus; their contrast against page/card surfaces exceeds 8:1. The date apply button also passes a 7:1 contrast check at rest and hover in both modes. A separate in-app exploratory pass covered ranking/model switches and the English date menu.
- Full-page pixel audits found no strongly chromatic colors outside lime/pink in the tested Clash views. Chromatic pixels occupied about 0.17% of the desktop dashboard, 0.42% of the users page, and 3.71% of mobile login; this measures the rendered samples, not every app route. Chart screenshots were achromatic and their canvases contained rendered pixels. Doughnut pixel transitions confirmed real hatch detail; visual review covered light/dark hatch direction and spacing, matching table markers, dashboard text, and date menus.

Dependencies were reused from the existing `sub2api-cursor` worktree because registry access failed. A fresh frozen-lockfile install has not been verified. Upstream's current remote HEAD has not been confirmed.

## Release Gate

Worktree: `/Users/clawbotbot/Projects/sub2api-skins`, branch `codex/feat/skin-system`, base `bdb42e22f81fcb633ff0a060961211dd2bcb515b`. The Cursor experiment is not included.

This preview is not deployed to the production Compose stack. Production remains on its fixed image and existing direct entry point. Source changes, tests, and this document are local until explicitly published; no remote push is implied by this preview.

Before release, confirm the appearance, resolve or explicitly accept the baseline test failures, install/build reproducibly against the chosen upstream baseline, test an isolated real backend, and complete the stable-entry blue/green preparation in the vault runbook. Check the candidate site's real behavior before switching new traffic. Keep the old instance until in-flight requests are drained and the new version passes observation. Static `/health` and this frontend preview do not prove production readiness or uninterrupted gateway service.
