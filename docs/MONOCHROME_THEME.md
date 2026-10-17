# Monochrome appearance

The third site skin, `monochrome`, pairs a white/light-gray mode with a near-black/dark-gray mode. It uses the existing administrator-controlled `site_appearance` setting. The original and restrained-neubrutalism skins remain available. This is an appearance extension to upstream version `0.2.13`, with no schema migration or new dependency.

The design uses neutral surfaces, fine borders, modest rounded corners and inverted primary actions. Color is not the only status signal: keep labels, icons and chart legends visible. The existing logo shape is retained; the default mark follows the neutral palette. An administrator's custom logo is preserved.

The stored accent color remains available when returning to another skin. Monochrome derives its action colors from the light/dark mode instead. Its settings explain this behavior.

## Review and acceptance

The first iteration used Herdr `qwen-pi`. The second iteration is implemented by the explicitly requested existing Herdr `pi-61sol` agent (`default`, pane `w1:p9`, `sub2api/gpt-6.1-sol`, medium reasoning) in the isolated `sub2api-monochrome` worktree. Codex owns design, synthetic preview fixtures, independent review, browser acceptance and deployment.

The second review found that palette replacement alone missed scoped CSS, inline SVG/chart colors and browser control accents. Generic glass/card rules also framed the header, flattened all corner radii and retained heavy nested panels. Shared monochrome tokens now cover those exceptions while preserving legacy fallback values. Headers are flat, settings use separated chapters, metric icon tiles are lighter, actions are pills, and fields/cards/circles retain distinct shapes. Contrast and selected-state checks supplement residual-color scanning.

The production settings page exposed a further cascade issue: lazy-loaded dark component rules restored filled active tabs and icon tiles despite a clean color scan. Active-state colors now read shared tokens directly. Monochrome settings use full-width labels in content-sized tabs, an underline selection, and a sticky bar flush with the header. Appearance has two aligned fields and hides the unused accent editor while retaining its saved value for legacy skins. Verify these states in the compiled candidate before activation; dev rendering and color scans alone cannot establish visual acceptance.

Required checks include settings save/reload and both theme directions, original-skin fallback, server-authoritative appearance, light/dark charts and tooltips, home/login, navigation, tables, quota overview, forms and overlays. Use realistic fixtures at desktop and mobile widths; inspect contrast, keyboard focus, horizontal fit and long content. Preview writes stay in memory and must not be forwarded to the live service.

`scripts/monochrome-audit.mjs` provides reusable read-only checks for 43 routes, computed colors (including pseudo elements), canvas pixels and candidate text-contrast issues. `scripts/preview-skin.mjs --skin monochrome --appearance dark --quota-preview --all-features` enables synthetic optional pages without changing live feature settings. Unknown APIs still fail and writes remain blocked except documented in-memory fixtures. Empty optional pages and the disabled operations dashboard do not establish populated production coverage; chart preview includes the populated operations header with selectable healthy, at-risk and unhealthy scores. The preview banner adds 30px to fixed/sticky shell offsets and is absent in production. Provider logos, user images, external checkout/identity frames and real payment flows are outside recoloring/checkout signoff.

## Local rollout

After review and qualification, fast-forward the clean canonical release worktree `/Users/clawbotbot/Projects/sub2api-neubrutalism` to the accepted source commit. Existing recovery tooling deliberately pins release manifests to that location. Keep its recovery and launchd paths intact.

Build one fixed ARM64 package with the existing resource-limited builder. Run exact-image smoke, take a fresh private backup and restore it in isolation, then use `upgrade-current.mjs prepare/activate/status` as described in [LOCAL_UPGRADE.md](LOCAL_UPGRADE.md). A real Responses completion must succeed before switching traffic; retain the previous image, protected configuration and historical assets. This task deploys only the local Mac service.

The first deployment is recorded in the Vault note `Sub2API - 极简黑白主题与本地上线`; the second iteration's exact image, source, validation, cutover and rollback evidence are recorded in `Sub2API - 黑白主题第二轮统一与视觉验收`. Packaging or mock browser checks alone are not production signoff.
