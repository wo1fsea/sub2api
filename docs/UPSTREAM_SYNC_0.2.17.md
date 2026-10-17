# Upstream sync to 0.2.17

On 2026-10-18, merge official `Wei-Shaw/sub2api` main into the customized fork. The previous local application baseline was `7b8b60c7827b5bcf8a594b770b02d22e30a81883` on upstream 0.2.13. Both existing customization branches were first pushed to `wo1fsea/sub2api`; nine previously local-only theme commits are now preserved remotely.

## Upstream and version

- Official release: `v0.2.17`, tag commit `060d0160417782cd962a0c7f460f6cd4565d4916`.
- Merged main: `b0a02a3304a0a78cdd003ddda1dd23ba02c03084`. Its only change after the tag is synchronizing `backend/cmd/server/VERSION` to `0.2.17`.
- Application VERSION and `deploy/local-upgrade/build-inputs.json` now agree on `0.2.17`. Frontend package version `1.0.0` retains its upstream meaning.
- Go tests, Docker build and CI use `1.27.2`; the local packaging image is pinned by registry digest. The original pnpm 9.15.9 packaging pin is retained.

## Conflict review

Eight conflicts were resolved with both parents as references. Actual Herdr `default / pi-61sol / w1:p9` (`sub2api/gpt-6.1-sol`) handled the five frontend conflicts and added a regression test for dynamic platform selection. Codex reviewed the result and handled backend/configuration/build metadata.

- Preserve all three skins, light/dark monochrome, settings anchor/navigation/accent retention, compact home, quota overview and legacy scheduler compatibility.
- Adopt upstream catalog-driven platforms, quota settings and account provider profiles. Dynamic account buttons retain their selected appearance and accessibility state.
- Preserve upstream Ops timezone/output-TPS changes, payment countdowns, Stripe recovery validation and lifecycle guards alongside local appearance tokens. Add populated output-TPS data to the reusable synthetic preview.
- Keep both legacy scheduler configuration tests and upstream minimum-output-token tests.
- Keep SheetJS 0.20.3 from its official tarball and the matching lockfile; do not reintroduce vulnerable npm xlsx 0.18.5 or its upstream audit exceptions.

## Schema and deployment boundary

Five upstream SQL files are new relative to 0.2.13: `242_drop_platform_check_constraints.sql`, `242_group_i18n.sql`, `243_gemini_cached_contents.sql`, `244_gemini_cached_contents_channel_usage.sql`, and `245_gemini_cached_contents_mutation_lease.sql`. They remove platform check constraints, add group translations, and create/extend Gemini cache storage and leases. They were not executed against production.

This is a source sync. The installed Mac service remains 0.2.13, source `7b8b60c7827b5bcf8a594b770b02d22e30a81883`, image `sha256:d24609d723262dc83cbc18534446648b85b8bd42e3f77f582df40e4b81c0c659`. Keep its recovery checkout at `/Users/clawbotbot/Projects/sub2api-neubrutalism`. HK, ingress, live settings and database were not changed.

The existing `upgrade-current.mjs` version guard remains 0.2.13. A 0.2.17 rollout requires migration/rollback review, a fresh backup and isolated restore rehearsal, exact-image smoke and qualified activation tooling; this merge does not establish those results.

## Validation

The machine-readable qualification is `deploy/local-upgrade/source-validation.json`. Raw reports and screenshots remain ignored under `frontend/tmp/upstream-sync-20261018`, `frontend/tmp/backend-tests` and `.out/upstream-sync-20261018`.

- Full frontend suite: 380 files, 2,927 tests passed; no failures or skips. Earlier conflict-focused run: 52 files, 656 tests passed. Full frontend ESLint: 940 files, zero errors/warnings. Typecheck passed.
- Backend unit suite: 57 packages passed; 23,337 passing test/subtest events, 18 skipped events, no failures, Go 1.27.2. Counts include nested subtests and are not counts of independent top-level tests.
- Deployment/recovery Node checks: 50 passed. Upstream shell checks passed, including mocked Apple container lifecycle, Compose security/environment/resource assertions and Caddy cache behavior.
- Independent synthetic-browser regression: settings anchor, light/dark save/reload, accent preservation and legacy return; keyboard End/Home tab navigation; dynamic Command Code/Cline selection; seven Ops metric cards and realtime window selection. Desktop 1440 and mobile 390/320 where applicable. No page errors or stable horizontal overflow on checked views; grayscale diagnostics and screenshots reviewed. Transitional screenshots are not stable-state evidence.
- This is focused merge regression coverage, not all-route production acceptance, real provider/payment testing or a complete accessibility audit. Production packaging and rollout checks remain separate.
