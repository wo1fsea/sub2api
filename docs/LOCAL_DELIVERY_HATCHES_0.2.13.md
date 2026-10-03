# Local delivery: cached hatches, 0.2.13

Activated at **2026-10-03 13:33:02 Asia/Shanghai** (`2026-10-03T05:33:02.380Z`). The original HTTPS entry now serves the cached-hatch refresh from **blue**, with the previous green instance retained. Version/current/latest remain `0.2.13`, `has_update:false`; future legitimate update notifications remain enabled.

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
