# Local Candidate 0.2.12-clash.2

Status: **candidate, awaiting the authorized minimal live gate**. Production remains on `0.2.4`.
This is the durable delivery record for the already-built image, not the current
branch HEAD. Later documentation and deployment-tool commits do not relabel it.
The `.1` candidate is superseded.

## Immutable Delivery

| Field | Value |
| --- | --- |
| Upstream | `v0.2.12`, `5106065716e494204fc0e8db16f68f6e9d576be0` |
| Image source | `d69e52c0ff2e1a3261757de646defe4a97193c02` |
| Branch | `codex/sync/20261002-v0.2.12`, pushed and remote SHA checked |
| Platform | `linux/arm64` |
| Archive | `sub2api_0.2.12-clash.2_linux_arm64_d69e52c0ff2e.tar.gz` |
| Bytes | `54,515,014` |
| Archive SHA256 | `d9fa82bec3a10c486473054731eb9c1684e9da8841dfe8a67ba7c1dd2acae8ec` |
| Imported image ID | `sha256:da20743ebb5610646c8a2898f0cd0c6850bda10d2ed20dbebd75242731563214` |
| Config digest | `sha256:1f4866d02d3506a484c52d951d04acd6a0cd354612767e0b61027c174767fab8` |
| Backend Git tree | `d710cce7f11532ce28de896cf30402a68c92deac` |
| Frontend Git tree | `903fbb153deb8129c6b03f3c32abfe1720b49f4a` |

The archive is in the checkout's ignored `release/` directory, not GitHub or Git.
Both the outer checksum and all seven inner checksums passed. The manifest remains
unchanged: build-time pending gates are qualified by separate runtime evidence,
not edited retroactively into approval.

## Verified Evidence

- Go `1.27.0` unit: 57 packages, 21,856 passing test events, 18 conditional skips;
  integration: 51 packages, 13,565 passing events, 16 conditional skips. Separate
  audit PostgreSQL/Redis tests: 214 passes, zero skips. Lint `2.13.0`: zero issues.
  Heap and absolute-deadline regressions repeated 20 times passed.
- The frontend tree is unchanged from the preceding qualification: 2604 tests,
  typecheck, lint, production build and synthetic desktop/mobile skin checks.
  Reuse is tied to the Git tree, not inferred from a version string.
- Exact-image package smoke passed, project `sub2api-smoke-8c861a8b2b89` cleaned:
  version/SHA, non-root user, setup/migrations, embedded files, login, 401,
  restart/session continuity and the expected compliance 423. No terms accepted.
- Protected actual backup restored on independent, no-egress dependencies:
  seven migrations, prior checksums, business projections, old JWT/compliance,
  admin reads, synthetic peer key writes/models and both image restarts passed.
  Project `sub2api-rehearsal-50c145520caa` cleaned. Candidate startup: 1898 ms.
  Refresh was disabled; no inference calls occurred. This is not a live-lock test.
- HAProxy project `sub2api-proxy-test-1084ccb8dd50` passed and cleaned: runtime
  activation/rollback, same-connection HTTP rerouting, long SSE/WebSockets,
  no POST replay on 500/transport failure and persisted-route restart recovery
  after isolated connections drained. Its write counter is not application drain.
- Read-only production config inspection confirmed the fixed JWT/TOTP environment
  keys and config match the restored backup. General encryption/payment signing
  reuse the TOTP key; `SECRET_ENCRYPTION_KEY` is not a separate configuration input.
  No secret values or config copies belong in this record.
- The separate asset drill passed: discovered 177 old and 179 new fingerprinted
  JS/CSS files. Exact byte digests and content types remained available after
  stopping the old application asset fixture. A separate old-image setup-mode
  resource instance runs as UID 1000, read-only, without secrets, dependencies,
  egress or host ports. The proxy uses an exact-path GET/HEAD map; setup/API/unknown
  paths and POST cannot reach that instance. The active-route switch does not
  restart the proxy. The drill changes only test health probes to `/`, because
  setup mode has no `/health`. It does not prove live old-browser/API compatibility
  or cover un-hashed media, fonts and arbitrary dynamically constructed URLs.

Local evidence: `frontend/tmp/backend-tests/run-sZ0JDE`, `run-NEPKBr`,
`frontend/tmp/audit-tests/run-Z22Zpu`, `frontend/tmp/proxy-tests/run-NLMLOA`, and the
private rehearsal report at
`/Users/clawbotbot/Projects/sub2api-upgrade-private/rehearsal-DOPU6a/rehearsal-report.json`.
The private backup manifest deliberately retains `restoreVerified:false`; the
separate exact-image report is the restoration evidence. PostgreSQL, Redis and
app-file snapshots were separate, not cross-store atomic.

Asset evidence is in `frontend/tmp/asset-tests/run-5qc7oj` and the successful
repeat `run-Y9Krqa`; both projects were cleaned. The asset helper and
proxy template were added after image construction, so they must be obtained
from the release branch rather than assumed to exist in the `.2` source archive.
The legacy resource instance is a continuity bridge, not a public setup site;
do not publish its port or route a whole prefix to it. Replace this bridge with
a qualified static archive later if maintaining an old executable is undesirable.

## Current Local Activation Gate

On 2026-10-02 the owner authorized testing with the current Codex API key/model
and switching directly once the candidate completes a real upstream response.
Full formal acceptance, ten-minute observation and drain are not activation
blockers for this local release. Disconnect/reconnect is accepted, but POSTs are
not replayed and lossless stream resumption is not promised. The old instance
stays alive for rollback and background-role ownership. Fresh protected backup,
the rehearsed compatibility restrictions and post-switch verification remain.
See [the current switch policy](LOCAL_UPGRADE.md#current-local-switch-policy).

## Additional Qualification Before Old Retirement

1. Authorized real account/key, model and cumulative budget; real streaming,
   multi-turn/tool behavior, billing, existing client/session and real browser checks.
2. Mixed-version background roles/leases and resource capacity, with unguarded
   account tests/channel checks/backup writes frozen. Keep legacy scheduler
   compatibility enabled while an old writer or rollback target can run.
3. First stable-entry and Tailscale migration, including forwarding trust and
   connection preservation. No production proxy is installed by these tests.
4. Real per-instance request/WebSocket, usage-worker and billing-cache drain.
   The old binary exposes no complete drain snapshot; neither HTTP/TCP zero nor
   fixture counters authorize stopping it. Usage/billing cleanup runs in parallel.
5. Three successive live readiness rounds, verified rollback eligibility, and
   at least ten minutes of post-switch business observation before retirement.

Keep the old service running when evidence is missing. Do not replace the only
container, restore an old snapshot during hot rollback, restart Docker/Colima,
or use the upstream updater to bypass this fork's release process.
