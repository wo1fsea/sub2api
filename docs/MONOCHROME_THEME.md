# Monochrome appearance

The third site skin, `monochrome`, pairs a white/light-gray mode with a near-black/dark-gray mode. It uses the existing administrator-controlled `site_appearance` setting. The original and restrained-neubrutalism skins remain available. This is an appearance extension to upstream version `0.2.13`, with no schema migration or new dependency.

The design uses neutral surfaces, fine borders, modest rounded corners and inverted primary actions. Color is not the only status signal: keep labels, icons and chart legends visible. The existing logo shape is retained; the default mark follows the neutral palette. An administrator's custom logo is preserved.

The stored accent color remains available when returning to another skin. Monochrome derives its action colors from the light/dark mode instead. Its settings explain this behavior.

## Review and acceptance

Implementation is delegated to the existing Herdr `qwen-pi` agent (`default`, pane `w1:p7`) using `sub2api/qwen3.8-flash-next-iq2_xs`, high reasoning, in the isolated `sub2api-monochrome` worktree. An initial standalone pi attempt was stopped and its partial changes handed over after the user clarified the required agent. Codex owns the design, independent review, browser acceptance and deployment.

Required checks include settings save/reload and both theme directions, original-skin fallback, server-authoritative appearance, light/dark charts and tooltips, home/login, navigation, tables, quota overview, forms and overlays. Use realistic fixtures at desktop and mobile widths; inspect contrast, keyboard focus, horizontal fit and long content. Preview writes stay in memory and must not be forwarded to the live service.

## Local rollout

After review and qualification, fast-forward the clean canonical release worktree `/Users/clawbotbot/Projects/sub2api-neubrutalism` to the accepted source commit. Existing recovery tooling deliberately pins release manifests to that location. Keep its recovery and launchd paths intact.

Build one fixed ARM64 package with the existing resource-limited builder. Run exact-image smoke, take a fresh private backup and restore it in isolation, then use `upgrade-current.mjs prepare/activate/status` as described in [LOCAL_UPGRADE.md](LOCAL_UPGRADE.md). A real Responses completion must succeed before switching traffic; retain the previous image, protected configuration and historical assets. This task deploys only the local Mac service.

The running image, exact source revision, validation results, cutover time and rollback command are recorded in the Vault note `Sub2API - 极简黑白主题与本地上线`. Packaging or mock browser checks alone are not production signoff.
