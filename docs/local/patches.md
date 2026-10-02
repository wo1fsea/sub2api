# Local Patch Ledger

This ledger tracks our intentionally small fork. Production approval is separate from source integration. The Cursor experiment remains in `feature/cursor-upstream-pool` and is not included here.

## Upstream Baseline

- Previous skin base: `bdb42e22f81fcb633ff0a060961211dd2bcb515b`.
- Running production source: `5de5e2bed035d43591a2e10e51f420ef6a84eb98` (`0.2.4`); do not confuse it with the development base.
- Selected stable target: `v0.2.12`, `5106065716e494204fc0e8db16f68f6e9d576be0`.
- Merge: `4d9ec797f185cbef46d58bd3c1a5f3f7a2d76a81`, no conflicts.
- Candidate branch: `codex/sync/20261002-v0.2.12`.
- Candidate version: `0.2.12-clash.2`, Linux ARM64; supersedes the `.1` candidate after requalification.

## Retained Changes

| Change | Commit or location | Verification and retirement condition |
| --- | --- | --- |
| One Clash skin, gray base, sparse fluorescent accents, hatch charts, two-tone dashboard text | `29ea51394617fd9c774a0fb8f01a6ee25ebd6d21`; `docs/CLASH_SKIN.md` | Frontend unit tests, typecheck, build, lint; synthetic desktop/mobile browser checks. Keep while this custom appearance is wanted; compare with upstream shell changes on every merge. |
| TypeSafe quota test fixture and assertions | `0d45c5146`; `frontend/src/api/__tests__/settings.authSourceDefaults.spec.ts` | Full frontend suite: 2604 passed. No business-logic change. Remove this local difference when upstream has equivalent six-platform coverage. |
| Exact local pnpm and bounded build resources | `Dockerfile`, `PNPM_VERSION`, `NODE_BUILD_OPTIONS`, `GO_BUILD_PARALLELISM`, `GO_BUILD_MEMORY_LIMIT` | Default pnpm remains major 9; local build sets 9.15.9, explicit Node heap, and Go compile limits. No runtime behavior change. Retire when upstream provides equivalent toolchain/resource inputs. |
| Auditable candidate packaging and isolated smoke tests | `deploy/local-upgrade/`; `docs/LOCAL_UPGRADE.md` | Build only committed source; pin base images; verify identity; export checksums; never change production traffic. Retain while local delivery needs this workflow. |
| Opt-in legacy scheduler projection compatibility | `backend/internal/config/config.go`, `backend/internal/repository/scheduler_cache.go`, repository provider and focused unit tests | `GATEWAY_SCHEDULING_LEGACY_SNAPSHOT_COMPAT=true` preserves RPM/threshold admission when an old writer publishes reduced metadata. Defaults off; full payload missing/corrupt never uses unsafe metadata. Retire after old writers/rollback targets are gone or upstream provides equivalent mixed-version support. |
| Deadline check before OAuth credential persistence | `oauth_refresh_api.go`, `token_refresh_service.go`, focused service tests | A context timer may run late under load even after the absolute deadline; reject late credentials on both unified and legacy refresh paths. Preserve the existing post-commit cleanup behavior. Remove after an equivalent upstream fix is incorporated. |
| Process-isolated retained-heap unit check | `billing_inflight_reservation_test.go` | Keep 20,000 random-model requests, no-DB assertions and the original 8 MiB retained-memory limit; isolate the measurement from unrelated suite allocations. Test-only, no production logic change. Remove after upstream supplies equivalent isolation. |
| Private restore/preflight and protocol failure drills | `deploy/local-upgrade/` | Read-only live inventory, protected bounded backups, no-egress restored old-data drill, credential-free bounded test reports and pinned HAProxy fixtures. These never grant production approval; actual readiness/drain remain separate gates. |
| Old lazy-chunk continuity drill and proxy template | `test-assets.mjs`, `haproxy-legacy-assets.cfg` | Actual old/new fingerprinted JS/CSS graph digests and types, exact-path GET/HEAD-only routing, secret-free non-root resource instance and old asset-fixture retirement. Added after `.2` packaging; not a live logged-in browser or application-drain check. |

## Verification Boundary

On the merged candidate, fresh frozen-lockfile dependency installation, frontend typecheck, full frontend lint, all 2604 frontend tests, and the production frontend build passed. Synthetic browser checks passed at 1440px, 983x895 at 2x density, and 390px/320px, including skin rollback, dark mode, persistence, hatch rendering, two-tone text, date menus, user dialogs, and rejected writes. Screenshots were reviewed independently of pixel/fit assertions.

Earlier whole-suite runs exposed a process-global heap assertion and deadline-timer races in both OAuth refresh paths, including under Go 1.27.0. Passing once with the upstream toolchain was not a root-cause fix. The retained-heap workload is now isolated without increasing its limit, and the refresh paths check the absolute deadline before persistence. Focused regressions repeated 20 times passed; the final full-suite qualification is recorded against exact backend/frontend Git trees in the source validation record.

An actual protected production backup was restored onto independent internal/no-egress PostgreSQL/Redis. Seven expected migrations, stable business projections including account hashes, old sessions, existing compliance, both admin read workflows, peer synthetic key writes and old/new restarts passed again on the exact `.2` image. This is fresh image evidence, not a relabeling of the `.1` result. Token refresh was disabled and no real gateway calls were made. The backup is not a cross-store atomic snapshot. Exact immutable identities and post-build results are in [the delivery record](../LOCAL_DELIVERY_CLASH_2.md).

HAProxy fixture checks passed for runtime activation/rollback, same keep-alive rerouting, old SSE/WebSockets, new WebSockets, no POST replay on 500/transport failure and persisted-route recovery. The separate actual-build asset drill passed for 177 old and 179 new fingerprinted JS/CSS dependencies, including continued access after stopping the old asset fixture. Mock write drain does not establish real application drain. Real low-budget model/client workflows, background-job/lease behavior, first Tailscale entry migration, live old-browser/full-media compatibility, actual async persistence drain and post-switch observation remain production gates. Keep the old process alive when any drain evidence is missing.

Build and synthetic startup results belong in the delivery record alongside the final source SHA and package digest. Never interpret a successful empty-database smoke test as permission to migrate production. Shared-database migration can affect the old site before traffic switches.
