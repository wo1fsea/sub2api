# Local delivery: cached hatches, 0.2.13

## Current deployment: recovery and legacy retirement, 2026-10-07

Recovered and retired the old applications at **2026-10-07 15:04:26 Asia/Shanghai**. The application image and embedded source remain the exact cached-hatch release below; this repair changes deployment and recovery scripts, not the application or upstream version.

The HTTPS entry again targets `127.0.0.1:18480`, now owned by `sub2api-current-ingress`. Its only application backend is `sub2api-current-app`, version `0.2.13`, direct loopback `18583`. Existing Hermes clients keep `18080`: `sub2api-current-compat` forwards that port to the new ingress. Ports 8443 and 9444 retain their previous targets. The original `sub2api`, both older green applications, `sub2api-blue-hatches`, and all three previous ingress/static containers were stopped during handover, then removed after user acceptance as recorded below.

The new app is the sole token-refresh, usage-cleanup and channel-monitor-v2 background owner. Enabled environment flags, token-refresh/cleanup startup messages and a successful monitor aggregation were verified. Legacy scheduler snapshot compatibility is disabled after retiring all older application writers. No shared-database restore or new application migration was performed. Scheduled tests, active monitors and scheduled backups were not enabled by this repair.

Old-page compatibility now uses a read-only, secret-free Caddy service on an internal network. All **439** historical JS/CSS files were copied, hashed and verified through the new ingress, totaling **17,294,450 bytes**. Historical assets route only for exact GET/HEAD paths; API requests continue to the new app. The current entry CSS contains the neubrutalism and diagonal-gradient markers.

Fresh real Responses calls with the current configured key/model completed through the direct candidate, recovered ingress and original HTTPS entry. The final handover HTTPS call returned HTTP 200, `blue`, actual `OK`, and a completed stream in **3210ms** with **3124ms** first-token latency. No automatic retries or POST replay were used. The first transition had **354/354** successful sampled health checks across HTTPS and loopback. A version-envelope assertion initially halted background handover safely; the guard was corrected and regression-tested before completing retirement.

System LaunchDaemon `/Library/LaunchDaemons/net.clawbotbot.sub2api-recovery.plist` runs at system load and every 60 seconds. Its root-owned dispatcher under `/Library/Application Support/Sub2API Recovery` drops privileges before running Colima, Docker or deployment code. It can start Colima and the pinned DB/Redis/current services; it refuses unexpected images, roles or an active retired owner. Current services use `always` restart policy and bounded Docker logs (two 5MB files per service). A crash-left operation lock is safely reclaimed after checking its former process owner.

The macOS Tailscale app requires GUI bootstrap IPC. Local recovery works independently of login; the dispatcher uses the owner's GUI context for route reconciliation when that context exists. Before login it leaves the already-persisted `443 -> 18480` configuration intact and records `routePending:true`. Thus local recovery does not depend on the older login-only Colima agent, while Tailscale control-plane availability before login is not newly proven.

A controlled drill temporarily routed HTTPS directly to the same healthy new app, then stopped the ingress. The system service restored the ingress at **15:14:17** and restored HTTPS to `18480`, with a successful full recovery record at **15:14:19**. The **177** HTTPS health samples collected during the shutdown interval all passed; these are samples, not proof that every connection or the entire drill interval was uninterrupted. The app, database and Colima were not restarted for this drill, and the Mac itself was not rebooted. A cold boot remains untested. The new recovery/gateway tests passed **14/14**.

Private desired Compose, asset cache, bounded latest recovery result and rollback records live under `/Users/clawbotbot/Projects/sub2api-local/current-0.2.13`; the fresh DB/Redis/old-app backup is under `/Users/clawbotbot/Projects/sub2api-upgrade-private/backup-9nyol8`. Credentials and runtime artifacts remain outside Git and the Vault.

```sh
cd /Users/clawbotbot/Projects/sub2api-neubrutalism
node deploy/local-upgrade/service-recovery.mjs status
sudo launchctl kickstart system/net.clawbotbot.sub2api-recovery
```

Before planned maintenance or a future upgrade, unload this recovery daemon so it cannot restore the pinned current topology during the operation; reinstall/reload it only after qualifying the replacement. Do not replay the historical `refresh-current.mjs`, `release-next.mjs` or `local-release.mjs` activation/rollback plans after retirement. Traffic rollback must not restore the shared database or start a second background owner.

### Cleanup after user acceptance, 2026-10-07

At **15:43:49 Asia/Shanghai**, explicit user authorization to clean the accepted old deployment was completed with `deploy/local-upgrade/cleanup-retired.mjs`. Removed **7** retired application/proxy/static containers, **4** old application-only volumes, **7** obsolete image tags and their unused image data, and the unused `sub2api-release-clash2_assets` network. Removed the stopped `sub2api-release-20261002` Buildx worker and its **8.654GB** cache volume. Current application/proxy images, shared DB/Redis and their volumes, the immutable release packages, upgrade backups and unrelated projects remain intact. No global Docker prune was used.

Moved the three old private release directories and a copy of the original Compose/inventory into `/Users/clawbotbot/Projects/sub2api-upgrade-private/retired-2026-10-07T07-43-45-821Z`. The active base `sub2api-local/compose.yaml` now defines only PostgreSQL/Redis and their volumes: the original application and `app-data` definition were removed to prevent accidental resurrection. These configuration records remain recoverable; deleted Docker application volumes and build cache cannot be restored in place. Business data remains in the unchanged shared database, and the existing upgrade backup remains available.

Recovery and status now accept missing retired containers while still rejecting a resurrected running owner. The system daemon successfully ran after removal with `ok:true`, `routePending:false`, and version `0.2.13`. All **439** historical cached resources still matched their recorded hashes. The cleanup/recovery/gateway tests passed **17/17**, and a fresh real HTTPS Responses probe completed successfully. Current application and database/Redis container IDs and start times were unchanged throughout cleanup. The Docker filesystem had **22GiB available** after cleanup; macOS sparse VM disk compaction was not performed.

## Historical delivery: 2026-10-03

The sections below describe the original October 3 delivery and are superseded by the current topology above. Activated at **2026-10-03 13:33:02 Asia/Shanghai** (`2026-10-03T05:33:02.380Z`). At that time the original HTTPS entry served the cached-hatch refresh from **blue**, with the previous green instance retained. Version/current/latest were `0.2.13`, `has_update:false`; future legitimate update notifications remained enabled.

## Immutable identity

| Item | Value |
| --- | --- |
| Upstream | `v0.2.13`, `3040209f205472038c1ba745a1bedd2edd9053b1` |
| Embedded application source | `186a750f0be036fa1870af5063a031a0ef8fb649` |
| Branch / checkout | `codex/feat/restrained-neubrutalism`, `/Users/clawbotbot/Projects/sub2api-neubrutalism` |
| Qualified frontend tree | `42c390d02eb0d3037af2eb924339eb2b979de352` |
| Unchanged qualified backend tree | `ce88118a2e6bc792697f2e438ebde6a6819381e0` |
| Image | `sub2api-local:0.2.13-186a750f0be0` |
| Imported image ID | `sha256:84a75cafee9d37d19df5de7f50924cacdf68ffd7c925485be421b496325979ea` |
| Image config digest | `sha256:cd4f2beb9da3b0b6aa171dafcfe24f9babfbf0a5c3da91e21825d6d3ba9ac82a` |
| Package | `release/sub2api_0.2.13_linux_arm64_186a750f0be0.tar.gz`, 54,566,728 bytes |
| Package SHA256 | `e1a4828603ea3f9ba2dcc794f67aed62932e8c0e4d4a88f5a4b044a10d97f390` |

The outer checksum and all seven inner checksums passed. Source was committed/clean at packaging and pushed/read back from the fork. Later documentation commits do not change the embedded application identity. The immutable manifest still describes a candidate; this record supplies actual deployment evidence. Earlier intermediate packages are not this deployed release.

## Appearance and qualification

Model/group/endpoint/user/Ops doughnuts, latency histograms and payment bars use grayscale diagonal tiles with matching legends. Account/subscription/key/provider quota, concurrency/SLA, channel-error and risk-score bars share scoped CSS hatching. Trends use neutral dash-separated lines without solid areas. Original appearance, independent dark mode, numerical values and axes are retained.

The Document-keyed WeakMap holds at most two palettes of twelve patterns. Mounts, refreshes and theme round trips reuse them; failed allocations are not cached. It is an in-document cache, not persistent canvas objects across full reloads. CSS data bars reuse one rule and preserve zero-width behavior.

Fresh final frontend suite: **2612 passed, 0 failed**, typecheck/full lint/production build passed. The unchanged backend tree reuses the previous full unit/integration/lint qualification in `source-validation.json`; no new backend suite result is claimed. Browser QA used synthetic preview fixtures at actual 1415x814, 983x895, 390x844 and 320x844: matching patterns, mode/original round trips, fourteen categories, source/metric changes, empty/loading returns, detail/refresh events, account modal and usage proportions passed. Narrow tables scroll internally, without settled page overflow. Download/zoom gestures and every tooltip hover were not newly inspected. See [chart QA](CHART_SKIN_QA.md).

A preceding final build reached the 2560MiB builder cgroup limit while Vite ran under persistent pnpm wrappers. The deployed package uses the same i18n/typecheck/Vite steps directly, with 2048MiB for typecheck and 1664MiB for Vite, keeping the builder cap unchanged. The recipe verifies upstream's build-script shape. Version metadata now invalidates compilation instead of dependency installation. The final exact build passed; the named builder is stopped with cache retained. Final host/VM disk checks showed about 34GiB / 11GB free. Docker/Colima and production containers were not restarted to build.

## Runtime evidence

- Exact final-image smoke passed: immutable labels, binary version/source, isolated empty DB/Redis, nonroot startup, login/session/401, compliance gate without accepting terms, embedded assets and restart/session continuity. Its disposable resources were removed.
- Fresh current-green backup `backup-dfqpf3` was restored into independent no-egress DB/Redis and separate app volumes. **Zero new migrations**, unchanged prior migration checksums/business projections, existing sessions/compliance, both admin read workflows, peer synthetic key writes/model discovery and both restarts passed on the final image. Rehearsal resources were removed. This is a consistent PostgreSQL dump plus separate Redis snapshot, not a cross-store atomic snapshot.
- Actual image asset drill passed for **179 old / 179 new** fingerprinted JS/CSS resources. The live stable ingress checked the **439-path union** of older and current-green resources byte-for-byte before and after cutover. GET/HEAD only; API/POST/unknown paths bypass the resource bridge. The HTTPS login page has blue's marker, and all six entry JS/CSS dependencies match the candidate's bytes and content types.
- The independent pinned HAProxy fixture drill passed: graceful master-worker reload, old SSE completion across reload/cutover, GET/HEAD asset routing, API/POST routing, persisted activation, runtime rollback and 47 healthy samples. This fixture tests proxy behavior, not application/model readiness.

Actual Responses probes used the current Codex key/model `gpt-6-astra`, max output 128, zero automatic retries:

| Probe | Total / first token | Usage | Result |
| --- | --- | --- | --- |
| Candidate `18582`, 13:32:21 | 2647 / 2503 ms | 24 input / 5 output | HTTP 200, actual OK, completed |
| Original HTTPS, 13:33:01 | 2738 / 1890 ms | 24 input / 5 output | HTTP 200, blue marker, actual OK, completed |

From **13:32:17 to 13:33:48**, 180 HTTPS and 180 loopback health samples all passed, covering inactive-backend reload, activation and subsequent service. Both green and blue markers were observed. This is sampled availability, not a guarantee that every client connection was uninterrupted. No POST replay or lossless resumption of an interrupted stream is promised.

## Running entry and continuation

- Original API remains `https://openclaw-macmini-ts.tailff52e6.ts.net/v1`; Tailscale 443 still targets `127.0.0.1:18480`. Full Serve configuration, including 8443→7777 and 9444→7779, is unchanged.
- Active `sub2api-blue-hatches`: container `7324f0b0c0f539b462a2aea7c2ac97fbe04108af36dcfc5ed2af531afca221de`, direct loopback `18582`, healthy/restart 0, independent app data with existing JWT/TOTP, shared production DB/Redis.
- Stable ingress remains `22ce08fc311bba07de9b4ea1bf3cd48c13ec5af85b9f84b15d3031c4876a8870`, original start time `2026-10-02T17:10:50.955383435Z`, restart 0. Config was written in place to retain the single-file bind inode and reloaded with SIGUSR2. Runtime and persisted maps both say blue.
- Previous `sub2api-green-v0213` at `18482` retains its original image/start time/restart 0, serving rollback and current-old assets. Earlier `.2` entry/static bridge remain available for older chunks. `sub2api` at `18080` remains the background refresh/cleanup/monitor-v2 owner; Hermes direct-client configuration is unchanged.
- Duplicate background roles are disabled in newer apps; legacy scheduler compatibility stays enabled. Scheduled account/channel tests and backup schedules remain frozen during coexistence. Do not stop the old owner or restore shared DB as traffic rollback.
- Private state/Compose: `/Users/clawbotbot/Projects/sub2api-local/releases/hatches-0.2.13` (0700/0600). Stable ingress files remain under `releases/v0.2.13/ingress`. Secrets, snapshots, logs and screenshots stay outside Git/Vault.

```sh
cd /Users/clawbotbot/Projects/sub2api-neubrutalism
node deploy/local-upgrade/refresh-current.mjs status
# Proves previous-green upstream availability, then moves only traffic:
node deploy/local-upgrade/refresh-current.mjs rollback
```

No production rollback was performed. The historical `release-next.mjs` pair is superseded for current status/rollback. The new helper pins this exact pair; a future release requires revising the plan, checking roles/migrations/dependencies and validating a new candidate, rather than blindly rerunning prepare. Plan role handover and retained-resource consolidation separately before retiring old instances.
