# Local source and release qualification: v0.2.19

Date: 2026-10-29. Status: v0.2.19 deployed and verified on the local Mac. Migration 246 opening was explicitly approved. Old image and rollback materials are retained.

## Git and upstream identity

- Branch: `codex/sync/20261028-v0.2.19`.
- Worktree: `/Users/clawbotbot/Projects/sub2api-sync-20261028-v0219`.
- Upstream tag: `v0.2.19`, annotated tag `e60cefeaf78f2fbfa95aa076029e28b40d0a5527`, peeled commit `dece26153621959ccd7635814f4b2d08304e681a`.
- Sync base: `fc235222a94de26b4e2b70fff01fdeac19d86c38`.
- Merge commit: `2c3ed74ad9c21a02ce073fb39dbacdba085be9c2`.
- Scheduler compatibility fix: `036d5c8c7`.
- Application source commit embedded in the built image: `2da76924e7cf050e2d9c6b98eed9b992db0d9756`.
- Version: `0.2.19`. Go toolchain: `1.27.3`. Target: `linux/arm64`.

## Package identity

- Local release directory: `/Users/clawbotbot/Projects/sub2api-sync-20261028-v0219/release/sub2api_0.2.19_linux_arm64_2da76924e7cf`.
- Image tag: `sub2api-local:0.2.19-2da76924e7cf`.
- Immutable image ID: `sha256:5a41a1ae1a94546096b9061b6e5b75ecb63ed9bda8c487c0fafbefcda36feb81`.
- Image config digest: `sha256:2424e491c70fca4082b32207c449f92c2c6e35ffec468de8aa4d3714d9a305ac`.
- Image archive SHA-256: `8299de782e7d70bc2f2d5dbf235b762bbc72ae1b9d3181cc2b4f41760dd072c9`.
- Manifest SHA-256: `fb2ece834d218d847fb4197d47a82da1e6fedd649642c024cd70049e3b4c2c68`.
- Source archive SHA-256: `107ff17a8e130971d73df0318ad1b00b4645d1db49d58d932d7b701efa25c684`.
- Outer bundle SHA-256: `34bf0e6b9f8722e61288a21a144737379334304d7dd858e1b762f93d67c7f618`.
- Build input: `golang:1.27.3-alpine@sha256:ee0dcdc452cb73890363fbef65fc333aeb0da7c24ba52f2c6428a37b0e7f4f1c`, pnpm `9.15.9`, bounded builder `2560m` / CPU quota `100000`.

## Source qualification

Recorded in `deploy/local-upgrade/source-validation.json` against backend tree `35f2ba969db47efd848bb122482e70a3a7aff03f` and frontend tree `7fe8f0c371f343786985f677cdd6326228b0b20c`.

- Backend unit: 58 packages, 24,400 passing test/subtest events, 35 skipped, zero failures.
- Backend integration: 51 packages, 14,646 passing events, 16 skipped, zero failures.
- Security-audit dependency suite: 218 passed, zero skipped.
- Frontend: 384 files and 3,070 tests passed; typecheck passed; full lint passed; i18n + `vue-tsc -b` + Vite production build passed.
- Local upgrade Node tests: 54 passed across cleanup, live gateway, service recovery and upgrade-current.
- Direct SheetJS dependency is the official `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`; the 0.18.5 lock entry is absent.

## Exact-image and proxy evidence

- Empty-database exact-image smoke passed: version/commit labels, offline version command, migrations on an isolated DB, health, non-root UID 1000, admin login, unauthenticated rejection, default appearance, ordinary-user appearance write denial, admin compliance gate, embedded JS/CSS, restart and session survival.
- HAProxy fixture passed: pinned configuration, old route before activation, atomic runtime activation without restart, same keep-alive reroute, old SSE over five seconds, old/new WebSockets, no replay of failed POSTs, runtime rollback, persisted route after isolated restart, production proxy not replaced.
- Asset continuity passed with the actual 0.2.13 image `sha256:d24609d723262dc83cbc18534446648b85b8bd42e3f77f582df40e4b81c0c659`: 180 old and 180 new fingerprinted JS/CSS files, no-egress read-only legacy resource instance, old fixture stopped while assets stayed available, GET/HEAD exact-path only.
- Application drain was not claimed. Fixture request/persistence drain is not production drain proof.

## Backup and isolated restore rehearsal

- Private backup: `/Users/clawbotbot/Projects/sub2api-upgrade-private/backup-aMakVZ` (mode 0700 directory, 0600 files).
- Backup source: container `sub2api-current-app`, old image `sha256:d24609...`, old version `0.2.13`.
- PostgreSQL dump: 35,219,876 bytes, SHA-256 `b9313ff82e9d47b6179f6532846aa92abaaad528bc33498d1794c2319463ca43`.
- Redis RDB: 282,825 bytes, SHA-256 `e0bc3697e4e4a08703fb7f6a8263a752136827bb4cc65af7ce63db37ef3a081a`.
- App data archive: 14,848 bytes, SHA-256 `65a34f239562c27fe96fed4dbcb817559aa6f01bf0a09ebf304cdf6a05d48049`.
- Rehearsal report: `/Users/clawbotbot/Projects/sub2api-upgrade-private/rehearsal-ASZFCs/rehearsal-report.json`.
- The rehearsal restored the real backup into isolated no-egress PostgreSQL/Redis and separate app volumes.
- Exactly eight target migrations ran with expected filenames and checksums: 242 (two files), 243, 244, 245, 246, 247, 248.
- Migration 246 changed exactly three rows: two Antigravity and one Gemini group changed `allow_image_generation=false` to `true`; all out-of-scope groups stayed unchanged.
- Migration 247 created `scoped_admin_api_keys` with the expected columns and zero key rows.
- Migration 248 created `groups.image_count_billing BOOLEAN NOT NULL DEFAULT false`; all restored groups remained disabled.
- Restored business projections stayed unchanged outside the explicitly asserted 246 gate changes.
- Existing sessions, compliance state, admin read workflows, appearance roundtrip and validation rejection behaved as expected.
- Both old 0.2.13 and new images read and wrote synthetic keys against the migrated copy; both restarted successfully and the migration set stayed stable.
- The backup is not a cross-store atomic snapshot. No live provider call was made by the rehearsal and token refresh was disabled.

## Mandatory production blocker

Read-only production inventory found two active Antigravity groups and one active Gemini group with `allow_image_generation=false`. Migration 246 will open all three. The owner has not decided whether that generation opening is approved. Therefore `prepare` was not executed, no candidate was attached to the shared production database, and no production write or route change occurred.

An auditable policy decision is required before prepare:
1. Approve opening those three groups, or
2. Define and test an approved migration-246 policy-preservation action that avoids an unapproved open window.

The migration file and checksum must remain unchanged. Do not edit migration 246 to encode business policy.

## Remaining gates

- Resolve the migration 246 policy gate.
- Prepare the exact image at `127.0.0.1:18585` with the shared PostgreSQL/Redis and disabled duplicate background roles.
- Run real `gpt-6.1-terra` and current configured Codex Responses calls on the candidate: completed event, response model identity, usage/billing row and no silent model substitution.
- Run current model and Gemini/Antigravity image regression under the approved policy and budget.
- Activate only after candidate and rollback evidence pass, then repeat through the stable entry.
- Complete stable-entry observation, asset checks, single background owner verification and actual drain investigation.
- Keep old image, package, configuration, backup and rollback materials. Hot rollback is not yet qualified because production preparation has not begun.

## Production completion 2026-10-29

- Owner explicitly approved migration 246 opening the affected two Antigravity and one Gemini groups.
- The account-level OpenAI model mappings for accounts 1, 2 and 9 were updated through the admin API with the existing credential merge path, preserving OAuth tokens and all other credential fields.
- Upstream model catalog sync exposed `gpt-6.1-terra` for all three OpenAI OAuth accounts.
- A temporary group-6 API key was used for validation and deleted after the stable-entry checks. Its private key file was removed.
- `prepare` succeeded at `2026-10-29T01:02:57.331Z`; `activate` succeeded at `2026-10-29T01:03:41.297Z`.
- Current phase: `active-old-retired`; operation phase: `active-verified`; route: `current`.
- Current immutable image: `sha256:5a41a1ae1a94546096b9061b6e5b75ecb63ed9bda8c487c0fafbefcda36feb81`.
- Current container: `sub2api-current-app`, healthy, image `5a41a1ae1a94`, loopback `127.0.0.1:18583`.
- Stable entries `http://127.0.0.1:18480` and `http://127.0.0.1:18080` both returned health OK.

### Real model and billing evidence

- Terra on 18480: HTTP 200, completed event, model `gpt-6.1-terra`, slot `blue`, 24 input tokens, 5 output tokens.
- Terra on 18080: HTTP 200, completed event, model `gpt-6.1-terra`, slot `blue`, 24 input tokens, 5 output tokens.
- Terra usage row on 18480: request `client:9cb37b0d-5868-426a-a2e0-413fba48c9b2`, upstream and response model `gpt-6.1-terra`, no mismatch, total and actual cost `0.000049`, billing mode `token`.
- Terra usage row on 18080: request `client:f5a733be-da22-4492-bb08-48162570cd71`, upstream and response model `gpt-6.1-terra`, no mismatch, total and actual cost `0.000049`, billing mode `token`.
- Current configured Codex model `gpt-6-astra` completed through both 18480 and 18080 with HTTP 200 and terminal completed events.
- A real `gpt-image-1` generation request through 18480 returned HTTP 200 with one image.
- The image usage row recorded `billing_mode=image`, image count 1, size 2K, 343 image output tokens, total and actual cost `0.201`.
- Temporary Terra-key cleanup: DELETE returned HTTP 200 and the protected key file was removed.

### State and rollback

- Candidate container was cleaned after activation; no listener remains on 18585.
- The old 0.2.13 image `sha256:d24609d723262dc83cbc18534446648b85b8bd42e3f77f582df40e4b81c0c659` remains retained.
- The already-migrated backup `backup-s1qLF1` and rehearsal `rehearsal-PR5v0v` verified old-image startup, old/new reads and writes, schema checksums and restart idempotence.
- Rollback images, private configuration, backup and rehearsal evidence remain available. Hot rollback was not executed after the successful cutover; it remains an operator action using the retained materials.
- Actual per-instance application drain was not claimed.

### Final validation

- `upgrade-current status` reports current image identity, route `current`, candidate absent, public health `ok`, 1266 historical assets verified.
- 18080 and 18480 both serve the new 0.2.19 runtime and the same background owner `sub2api-current-app`.
- No secrets, key material, backup files or image artifacts were committed.
