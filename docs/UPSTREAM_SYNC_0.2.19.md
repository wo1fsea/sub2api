# Upstream sync to 0.2.19

Source sync date: 2026-10-28 (Asia/Shanghai). Updated 2026-10-29 after local production activation and host recovery verification. The local Mac now serves 0.2.19; migration 246 opening was explicitly approved. Detailed runtime and billing evidence is in [LOCAL_DELIVERY_0.2.19.md](LOCAL_DELIVERY_0.2.19.md).

## Upstream and merge identity

- Sync base: `codex/sync/20261018-v0.2.17` at `fc235222a94de26b4e2b70fff01fdeac19d86c38`.
- Official tag: `v0.2.19`, annotated tag object `e60cefeaf78f2fbfa95aa076029e28b40d0a5527`, peeled commit `dece26153621959ccd7635814f4b2d08304e681a`.
- Local and `origin` tag objects agreed at execution time. Floating `origin/main` was not merged.
- Upstream tag VERSION was still `0.2.18`. The follow-up upstream version-sync commit `a9240d5016c226b341242a8c54a01a8605cbbc72` changes only `backend/cmd/server/VERSION`; the merge subtree adopts `0.2.19` explicitly.
- Merge commit: `2c3ed74ad9c21a02ce073fb39dbacdba085be9c2`, with parents `fc235222...` and `dece261...`.
- Scheduler compatibility follow-up: `036d5c8c7` (`fix(repository): preserve legacy scheduler full-payload reads`).
- Target branch: `codex/sync/20261028-v0.2.19`; worktree: `/Users/clawbotbot/Projects/sub2api-sync-20261028-v0219`.

## Conflict review

Four files required manual resolution. Both parents were used as references; no whole-file ours/theirs selection was accepted.

- `.gitignore`: preserved the local documentation allowlist for the skin, local upgrade, delivery and `docs/local` records, and retained upstream `docs/admin-api-keys.md`.
- `backend/internal/repository/scheduler_cache.go`: retained upstream cached snapshot masters, copy-on-read and revision tags. The local `GATEWAY_SCHEDULING_LEGACY_SNAPSHOT_COMPAT` mode reads full `sched:acc:*` payloads when enabled, re-projects the safe admission fields, bypasses process-local snapshot reuse so a removed full payload is observed immediately, and never falls back to unsafe reduced metadata.
- `frontend/package.json`: adopted the stricter upstream security overrides for DOMPurify, source-map-js and follow-redirects; retained the local SheetJS 0.20.3 official tarball pin.
- `frontend/pnpm-lock.yaml`: overrides mirror `package.json`; no vulnerable npm `xlsx` dependency was reintroduced.

## Local customizations retained

The merged tree retains the three skins, Restrained Neubrutalism, monochrome light/dark, OpenJev paper/ink, grayscale hatch charts, compact home, settings navigation, quota overview, legacy scheduler compatibility, deadline checks before OAuth credential persistence, bounded build resources and the private local-upgrade drill tooling. Upstream catalog-driven account platform selection, quota settings, provider profiles, Grok model diagnostics, scoped administrator API keys and image-count billing were adopted.

## Schema delta from the pre-upgrade 0.2.13 baseline

The fixed target adds eight migration files relative to the pre-upgrade `0.2.13` schema, which ended at the two `241` files. These migrations were rehearsed before the production upgrade:

| Migration | Checksum |
| --- | --- |
| `242_drop_platform_check_constraints.sql` | `a7725f31f637208d200e0f37d5270e9f263743d99fa9e4f1bb9a7387e8be5a61` |
| `242_group_i18n.sql` | `e81c6818cc806bc54365c993f4cec1634f16a311451faf5cb1a875a1358774cd` |
| `243_gemini_cached_contents.sql` | `2d345cff5c64b01e705f04ec972e5d5ec3d618fe71dc7d45bc80fdd38c6a89d5` |
| `244_gemini_cached_contents_channel_usage.sql` | `9072cb37752a23c3a29cc0330a69837f09c5102375ee053d7bccf14634d3da29` |
| `245_gemini_cached_contents_mutation_lease.sql` | `75434a7beeb8aad09b3339708ed520604d153e99c7fe680a376e8c958aadb1e8` |
| `246_enable_gemini_image_generation_groups.sql` | `87267be7ab657173768989e2b0b105c5569c5930a7f1ed124f4cf81e5198297c` |
| `247_scoped_admin_api_keys.sql` | `03445774e2dfad32da9e23279193d1bca02953896bc3d3b8a87ba0b36b6ed577` |
| `248_group_image_count_billing.sql` | `a872dde339b19f311feb5fa6fd85c8ff7b11d69794c35a18e2086d9846b3499c` |

Checksums use the application migration rule: SHA-256 over the migration file after trimming surrounding whitespace.

## Approved production policy for migration 246

Read-only pre-upgrade inventory on 2026-10-28 found three active groups affected by migration 246 because their platform was Gemini or Antigravity and `allow_image_generation` was false:

- Antigravity: two groups.
- Gemini: one group.
- Composite: one group was `true`, out of scope for 246.
- OpenAI: one group was `false`, out of scope for 246.

No IDs, names or credentials are recorded here. On 2026-10-29 the owner explicitly approved opening generation on the two Antigravity groups and one Gemini group. This resolved the policy gate before successful production preparation and activation. The migration file and its checksum remain unchanged; the isolated rehearsal verified the three expected changes and unchanged out-of-scope groups.

## Tooling adaptation

- `upgrade-current.mjs` now has an explicit supported-version set for the installed `0.2.13` recovery identity and the fixed `0.2.19` target. Target preparation rejects any other version.
- Candidate operations now use version-aware `sub2api-upgrade-*` directories, Compose projects and container names. The installed deployment path remains `/Users/clawbotbot/Projects/sub2api-local/current-0.2.13`.
- Candidate compose enables `GATEWAY_SCHEDULING_LEGACY_SNAPSHOT_COMPAT=true`; promotion restores it to `false` with the other single-owner background roles.
- All shared-appearance/version checks now carry the expected old or new version explicitly.
- The real Responses probe can request a model and requires the completed event to report the expected response model. Terra validation also waits for the exact request-id usage row, checks Terra model identity, rejects upstream mismatch, and requires positive token usage and billing.
- `rehearse-private.mjs` now accepts only the `0.2.13` to `0.2.19` path and asserts the exact eight-file migration set and checksums, migration 246 gate changes, migration 247 schema without key material, migration 248 default-off behavior, old/new writes and restart idempotence.
- `service-recovery.mjs`, `test-backend.mjs`, `test-audit.mjs` and `test-proxy.mjs` were updated for the target Go `1.27.3`; the pinned Go base image is `golang:1.27.3-alpine@sha256:ee0dcdc452cb73890363fbef65fc333aeb0da7c24ba52f2c6428a37b0e7f4f1c`.

## Validation status

Source qualification is recorded in `deploy/local-upgrade/source-validation.json` against the final application trees. Exact-image smoke, backup and isolated restore rehearsal passed. After the migration-246 policy approval, prepare and activate completed on 2026-10-29. Real Terra and current-Codex calls passed through the stable entries; Terra model identity and positive billing were verified. See the delivery record for exact package identities, evidence and validation limits.

## Host recovery verification

The installed launchd dispatcher calls `/Users/clawbotbot/Projects/sub2api-neubrutalism/deploy/local-upgrade/service-recovery.mjs` every 60 seconds. That host checkout's recovery script, `live-gateway.mjs` and `service-recovery.test.mjs` were aligned with this sync branch, removing the stale 0.2.13-only manifest-path/version assumptions while retaining release identity checks. All 16 recovery/live-gateway tests passed.

The host `boot` command succeeded in the launchd-compatible GUI session context at `2026-10-29T01:12:59.627Z`. A subsequent read of `/Users/clawbotbot/Projects/sub2api-local/current-0.2.13/boot-status.json` showed `checkedAt=2026-10-29T01:13:42.700Z`, `ok=true`, `version=0.2.19`, `routePending=false` and image `sha256:5a41a1ae1a94546096b9061b6e5b75ecb63ed9bda8c487c0fafbefcda36feb81`. Both stable ports returned health OK and authenticated version 0.2.19; state, manifest, private Compose and the running image agreed. This verifies the recovery command and current service state, not a host reboot drill.

## Production boundary

The source-integration phase was followed by the approved local Mac production upgrade, including migrations and account model-mapping updates documented in the delivery record. The local runtime is now `0.2.19`; the directory name `current-0.2.13` remains the stable deployment path. No HK deployment, Cursor branch integration, upstream push, force-push or secret export was performed. Documentation and host recovery alignment do not change the application source commit embedded in the deployed image (`2da76924e7cf050e2d9c6b98eed9b992db0d9756`).
