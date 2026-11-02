# Local release delivery: Factory upstream on 0.2.19

Date: 2026-11-02 (Asia/Shanghai). This document records the second immutable 0.2.19 local revision, which adds the accepted Factory upstream feature to the established `codex/sync/20261028-v0.2.19` release line. The application version remains `0.2.19`; the source revision and image digest distinguish this release from the earlier deployed 0.2.19 build.

## Identity

- Formal release branch: `codex/sync/20261028-v0.2.19`.
- Image source commit: `d784fb507d192ed6c203d0291be03b1abe600480`.
- Ops/tool commit: `e7e084a2212aca8996c5fc21a32fd1ba48090859` (clean worktree; same backend, frontend and migration trees as the image source). The application image was not rebuilt for this ops-only correction.
- Candidate/promoted image: `sub2api-local:0.2.19-d784fb507d19`.
- Immutable image: `sha256:b11cdf9fbdb326a5b0cc400b3e6c94f972274647c488714c493d8f2307696a47`.
- Image config digest: `sha256:129edbcfc2bef02385f68cbe03495a7d12c0b2a260f7a560df64dc51d6a0513e`.
- Manifest: `/Users/clawbotbot/Projects/sub2api-factory-develop/release/sub2api_0.2.19_linux_arm64_d784fb507d19/manifest.json`, SHA-256 `b586b8ea8298ff6abf1ab9dd2982d23fc373799a733daccb740120595e77b56d`.
- Bundle SHA-256: `6e41bed32bef02c2db75ca6cfd72de6cf1a758ffc5c1ab6ca29aea86e6867932`.
- Prior retained 0.2.19 image: `sha256:5a41a1ae1a94546096b9061b6e5b75ecb63ed9bda8c487c0fafbefcda36feb81`; source `2da76924e7cf050e2d9c6b98eed9b992db0d9756`.

## Source qualification and package gates

- No migration is added relative to the deployed 0.2.19 schema: 299 source migration files and 299 deployed rows match exactly by filename and trimmed-content checksum, including the real `006b`, `042b`, `043b`, `044b`, `046b`, `108a`, `120a`, `154a`, `175a` and `238b` names.
- Backend unit: 59 packages passed, zero failures, Go 1.27.3.
- Backend integration: 52 packages, 14,658 pass events, 19 skips, zero failures.
- Security audit dependency suite: 218 passed, zero skipped.
- Frontend exact-tree evidence: 386 files / 3,075 tests passed, typecheck/lint and production build passed.
- Deploy-tool suite: 74/74 passed for the P0 tools; later same-version projection/tool-identity delta passed 76/76.
- Exact-image empty-database smoke: 15 checks passed.
- Asset continuity: 180 old and 180 new fingerprinted JS/CSS files passed against prior image `5a41`; this is not an application-drain claim.
- Proxy fixture: 14 checks passed; it is a fixture, not production drain proof.
- The source qualification does not claim live provider inference by itself.

## Backup

- Private backup: `/Users/clawbotbot/Projects/sub2api-upgrade-private/backup-qndUzX`, directory mode 0700.
- Window: started `2026-11-02T15:45:16.779Z`, finished `2026-11-02T15:45:24.198Z`.
- Backup manifest SHA-256: `dca79f5efa00632858e5d21879887eee7bc0cff185ab94ade7bbce4316450acf`.
- PostgreSQL logical dump: 38,800,437 bytes, SHA-256 `2d5e7477828c7c572d0e2a2e0398f0c8d42f6880e7557847e60424992cfa7fa4`.
- App-data archive: 15,279 bytes, SHA-256 `3314bb86d4257c422bd1de77652bb85a419f6690bd77033d55f0c7d7305bc82b`.
- Redis snapshot: 6,799,260 bytes, SHA-256 `22befa6d4d6a463eefd883fbe47a78ac4a30af548db908f403b1f9cce11df4e7`.
- Original `.env`, private Compose, state and container recovery environment were copied mode 0600. `.env` remains 605 bytes, mode 0600, SHA-256 `63503f4f21908be7b28ba9686c109e20498cb489ef429a9f8277c42d08a0bc14` before and after cutover.
- Actual PostgreSQL data directory is `/var/lib/postgresql/data`, on named volume `sub2api_postgres-data`; PostgreSQL 18.6, database `sub2api`, 299 migrations. The anonymous parent mount is recorded separately. This is a logical database backup, not an atomic cross-store snapshot.

## Isolated same-version rehearsal

- Report: `/Users/clawbotbot/Projects/sub2api-upgrade-private/rehearsal-aq4sBU/rehearsal-report.json`, SHA-256 `2c2d085af6f2dc9a726ecc15a8d4d6972255f801c0ebeebd561ddfa1ac7b243f`.
- Report directory 0700, report file 0600, `cleanupErrors=[]`, `cleanupSucceeded=true`, `scriptCompleted=true`, `passed=true`.
- Ops-tool SHA `e7e084a2…` was clean; nine tool-file hashes and image source `d784fb50…` were recorded. Backend/frontend/migrations trees equal the image source.
- Internal network, no host-published ports, separate app/DB/Redis volumes, helper containers network `none`, provider refresh/cleanup/monitor disabled.
- 299 deployment migrations stayed 299; no filename/checksum additions, removals or changes. All source filenames, including letter-suffixed names, normalized and matched.
- Business projections, migration-246 image gates, scoped-admin-key rows, migration-248 image-count billing values, unlimited-quota rows and persisted settings table hash `4ab39a76…` stayed unchanged through startup and both restarts.
- The only admin-settings API projection delta is the expected source-version default addition `default_platform_quotas.factory={daily:null,weekly:null,monthly:null}`. All existing top-level values and pre-existing platform quota values remain pairwise equal; this is explicitly modeled and tested, not a generic omission.
- Old and candidate images both created synthetic keys, read peer writes, authenticated, listed models and restarted successfully.
- The earlier failed report `rehearsal-Luk2Do` remains retained but is not treated as a pass.

## Preparation and cutover

- Preparation completed `2026-11-02T16:02:05.588Z`; candidate stayed passive at loopback `18585` with restart `no` and all duplicate background roles disabled.
- Prior snapshot pins: Compose SHA-256 `ac23b018f906215b33d19d4efc668a9a31fde709625dfee462609a83d25da71f`, state SHA-256 `00d149cd84d763ae2a9de2250b470d2e9dc7af626e6bdfa6b03a4a0ff6ea64f9`.
- Candidate current-Codex probe: HTTP 200, completed Responses stream, model `gpt-6-astra`, 24 input / 5 output tokens, no retry.
- Candidate Terra probe: HTTP 200, completed Responses stream, model/upstream/response `gpt-6.1-terra`, 24 input / 5 output tokens, total and actual cost `0.000049`, billing mode `token`, no retry.
- Activation completed `2026-11-02T16:07:05.512Z`; operation phase `active-verified`.
- Current app: `sub2api-current-app`, container `cf329faf0f16e3f904f86c7755c8bb93123c70bb76c5001aa5616efab8aa7ef3`, image `b11cdf9f…`, healthy, restart policy `always`, restart count 0, sole background owner, loopback `127.0.0.1:18583`.
- Candidate was removed by the tool; release lock is absent. Route is `current`, stable entry is `18480`, compatibility entry is `18080`; Tailscale 443 still points to `18480`, and 8443/9444 were preserved.
- Host recovery readback: `boot-status.json` at `2026-11-02T16:10:57.100Z` recorded `ok=true`, image `b11cdf9f…`, version `0.2.19`, background owner `sub2api-current-app`, routePending false.
- Final entry probes through `18480` passed for current Codex and Terra with completed streams and positive usage; 1,378 cached historical assets passed.

## Existing-client acceptance

- t18 gateway/catalog/HTTP gate passed with no regression:
  - Existing client keys 7 and 9 remained in group 10 and retained the same 30-model catalog; no added or missing models in the comparison.
  - Terra: HTTP 200, completed, exact usage row `218961` attributed to account 2/model `gpt-6.1-terra`.
  - DeepSeek: HTTP 200, completed, exact usage row `218963` attributed to account 8/model `deepseek-v4-flash`.
  - Health, unauthenticated 401, registration disabled, and old/new entry assets passed.
  - Terra end-to-end observed latency was 32.6 seconds with the usage row appearing about 1.5 seconds after completion; no automatic retry.
- t16 Pi post-cutover comparison passed serially with one call per node and no configuration mutation:
  - macmini: exit 0, terminal completed, provider `sub2api` / API `openai-responses` / model `deepseek-v4-flash`, `PI_BASELINE_OK`, usage 226 input / 7 output / 489 total (equal to prior total).
  - ppc: exit 0, terminal completed, same provider/API/model, `PI_BASELINE_OK`, usage 271 input / 7 output / 534 total; prior total 544, no terminal/model regression.
  - Separate-peer HTTPS: from ppc over `https://openclaw-macmini-ts.tailff52e6.ts.net/health` (443) returned HTTP 200 `{"status":"ok"}`; no paid call.
  - Evidence: `/tmp/factory-prod-fleet-c-postbaseline.json`, SHA-256 `a84c1835bd509fb0cdae9e38b862888c75712ccc42fc0a58867108cd412f16e2`.
  - Acceptance report: `/tmp/factory-prod-accept-report.md`, SHA-256 `3348bb149914842b71e35a3d0d4e5c5d88d1eccf801d454a60961b1bf1cee314`; postcutover evidence `/tmp/factory-prod-accept-postcutover.json`, SHA-256 `c07b70cbec6a980270c85dc72417c8b55c46939ec355ecaf5f773175a34cc3af`.
- No existing Sub2API Claude catalog route is claimed: the current catalog/group baseline has no Claude entries, account 12 is not bound, and the separate Claude client is unrelated. Factory Claude onboarding remains deferred and separate.
- No rollback was triggered because no regression was observed.

## Rollback

Concrete emergency command after this preparation/activation:

```sh
node /Users/clawbotbot/Projects/sub2api-factory-develop/deploy/local-upgrade/upgrade-current.mjs rollback /Users/clawbotbot/Projects/sub2api-factory-develop/release/sub2api_0.2.19_linux_arm64_d784fb507d19/manifest.json
```

The reviewed path restores the retained prior 0.2.19 image and saved prior Compose/state and stable route under the shared release-operation lock. It verifies local old identity/health, persists prior state and route before optional auth/inference post-checks; shared auth/upstream failure is recorded as unverified and cannot block the actual restoration. It never restores PostgreSQL/Redis snapshots or discards newly recorded usage. Old image and prior packages remain retained.

## Boundaries

- The application image remains source `d784fb50…` and digest `b11cdf9f…`. This docs/ops commit changes no application binary.
- No Factory live key was read, no Factory account was created, and no Pi/WPC configuration was changed in this lane.
- No HK deployment, origin push, force push, `.env` modification, secret export, or unrelated workload mutation was performed.
- t9 weekly log review was not interrupted; retired unrelated containers were preserved.
