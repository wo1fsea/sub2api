# Local Patch Ledger

This ledger tracks our intentionally small fork. Production approval is separate from source integration. The Cursor experiment remains in `feature/cursor-upstream-pool` and is not included here.

## Upstream Baseline

- Previous skin base: `bdb42e22f81fcb633ff0a060961211dd2bcb515b`.
- Running production source: `5de5e2bed035d43591a2e10e51f420ef6a84eb98` (`0.2.4`); do not confuse it with the development base.
- Selected stable target: `v0.2.12`, `5106065716e494204fc0e8db16f68f6e9d576be0`.
- Merge: `4d9ec797f185cbef46d58bd3c1a5f3f7a2d76a81`, no conflicts.
- Candidate branch: `codex/sync/20261002-v0.2.12`.
- Candidate version: `0.2.12-clash.1`, Linux ARM64.

## Retained Changes

| Change | Commit or location | Verification and retirement condition |
| --- | --- | --- |
| One Clash skin, gray base, sparse fluorescent accents, hatch charts, two-tone dashboard text | `29ea51394617fd9c774a0fb8f01a6ee25ebd6d21`; `docs/CLASH_SKIN.md` | Frontend unit tests, typecheck, build, lint; synthetic desktop/mobile browser checks. Keep while this custom appearance is wanted; compare with upstream shell changes on every merge. |
| TypeSafe quota test fixture and assertions | `0d45c5146`; `frontend/src/api/__tests__/settings.authSourceDefaults.spec.ts` | Full frontend suite: 2604 passed. No business-logic change. Remove this local difference when upstream has equivalent six-platform coverage. |
| Exact local pnpm and bounded build resources | `Dockerfile`, `PNPM_VERSION`, `NODE_BUILD_OPTIONS`, `GO_BUILD_PARALLELISM`, `GO_BUILD_MEMORY_LIMIT` | Default pnpm remains major 9; local build sets 9.15.9, explicit Node heap, and Go compile limits. No runtime behavior change. Retire when upstream provides equivalent toolchain/resource inputs. |
| Auditable candidate packaging and isolated smoke tests | `deploy/local-upgrade/`; `docs/LOCAL_UPGRADE.md` | Build only committed source; pin base images; verify identity; export checksums; never change production traffic. Retain while local delivery needs this workflow. |

## Verification Boundary

On the merged candidate, fresh frozen-lockfile dependency installation, frontend typecheck, full frontend lint, all 2604 frontend tests, and the production frontend build passed. Synthetic browser checks passed at 1440px, 983x895 at 2x density, and 390px/320px, including skin rollback, dark mode, persistence, hatch rendering, two-tone text, date menus, user dialogs, and rejected writes. Screenshots were reviewed independently of pixel/fit assertions.

The full backend unit suite has one failing process-global heap-growth assertion, `TestInflightEstimate_AccountMappingNoDBAndBoundedMemory`; the other 56 packages passed. The backend is unchanged from `v0.2.12`, and the test passed in isolation. Its suite sensitivity is unresolved; the assertion is not relaxed and no production fix is implied. Backend integration tests, matching golangci-lint, real gateway calls, restored old-data migration rehearsal, mixed-version background jobs, and production hot-switch rehearsal remain release gates.

Build and synthetic startup results belong in the delivery record alongside the final source SHA and package digest. Never interpret a successful empty-database smoke test as permission to migrate production. Shared-database migration can affect the old site before traffic switches.
