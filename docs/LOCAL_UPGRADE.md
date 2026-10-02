# Sub2API Local Upgrade

This package is a Linux ARM64 release candidate combining upstream `v0.2.12` with our grayscale Clash skin and an opt-in mixed-version scheduler compatibility mode (`0.2.12-clash.2`). It is not approval to deploy. Packaging never changes the running service, production database, secrets, or traffic route. The Cursor experiment is excluded.

## Current Local Switch Policy

On 2026-10-02 the owner explicitly authorized a simpler local switch: use the
current Codex API key/model, prove the new instance completes a real upstream
response, then switch the entry without waiting for full formal acceptance or
application drain. Client reconnects are acceptable; lossless replay/resumption
is not guaranteed. Keep the old instance as a rollback target. This supersedes
the full-acceptance requirement for this local activation, not the data backup,
new-before-old ordering, prohibition on blind POST replay, or secret protection.

`local-release.mjs` implements separate prepare/verify/activate/rollback/status
operations for the observed local deployment. It never stops the old instance
or recreates PostgreSQL/Redis. Prepare uses a fresh protected backup, separate
candidate app data, the existing shared dependencies, legacy scheduler mode,
bounded resources, and a stable proxy initially pointing to old. Candidate
refresh/cleanup/monitor aggregation are disabled while the old process owns
those roles. Activation first changes the proxy runtime map, then updates only
Tailscale HTTPS 443 to `127.0.0.1:18380`; HTTPS 8443 is preserved. It verifies a
second real stream through the original Codex URL and restores the old route
if activation verification fails. Local direct clients on `18080` still use old;
new local clients should use `18380`. Secrets/state stay in the private deployment
directory, never in this fork. Do not use `compose down` on that release project
as a rollback procedure; use the rollback command while both instances remain.

```sh
node --test deploy/local-upgrade/live-gateway.test.mjs
node deploy/local-upgrade/local-release.mjs prepare /absolute/path/to/manifest.json /absolute/path/to/fresh/backup
node deploy/local-upgrade/local-release.mjs verify
node deploy/local-upgrade/local-release.mjs activate
node deploy/local-upgrade/local-release.mjs status
# On an authorized rollback, after checking old upstream availability:
node deploy/local-upgrade/local-release.mjs rollback
```

Real probes send one short Responses request each, using the configured model
and process `SUB2API_API_KEY`, with output capped at 128 tokens and no automatic
retry. They require HTTP 200, SSE, actual output and a completed terminal event;
HTML 200, failed/incomplete events and wrong instance markers fail the check.
The JSON probe record contains timing/token counts only, not the key or response
text. No acknowledgement of legal terms or default Codex configuration change
is performed. The older full formal procedure below remains a reference for
later production-grade releases and old-instance retirement.

The exact `.2` package and post-build evidence are recorded in [the delivery record](LOCAL_DELIVERY_CLASH_2.md). A later deployment-tool/documentation commit is not the source revision embedded in the existing image.

## Package Contents

- `image.tar`: Docker image including the compiled gateway and embedded frontend.
- `source.tar.gz`: committed source, without dependencies, secrets, runtime data, or database backups.
- `manifest.json`: version, full source and upstream commits, image ID, pinned build inputs, and outstanding production gates.
- `source-validation.json`: source checks tied to exact backend/frontend Git trees; not real-call or production approval.
- `SHA256SUMS`: checksums of package contents.
- `README.md`: this upgrade procedure.
- `smoke.mjs` and `smoke-compose.yaml`: isolated synthetic runtime checks, never a production upgrade command.

The outer archive also has a `.sha256` sidecar. Compare that digest with the trusted delivery record; checksums detect corruption but do not authenticate an untrusted download. Use the immutable image ID from the manifest for rehearsal and deployment, not a mutable `latest` tag.

## Verify and Import

Work in a new private release directory, inspect the archive listing, and extract there. Then verify both levels of checksums:

```sh
# In the delivery directory, substitute the actual archive filename.
shasum -a 256 -c sub2api_VERSION_linux_arm64_COMMIT.tar.gz.sha256
tar -tzf sub2api_VERSION_linux_arm64_COMMIT.tar.gz
tar -xzf sub2api_VERSION_linux_arm64_COMMIT.tar.gz
cd sub2api_VERSION_linux_arm64_COMMIT
shasum -a 256 -c SHA256SUMS
docker load --input image.tar
```

Importing an image does not upgrade an existing container. Compare `docker image inspect IMAGE --format '{{.Id}} {{.Os}}/{{.Architecture}}'` with `manifest.json`, and run `docker run --rm --network none IMAGE /app/sub2api -version`. Docker image-store versions may report a manifest digest or a config digest as the ID; when importing on another engine, also check architecture and the full source/version labels. Do not run `docker compose down` or replace the only production application container. Do not use the built-in online updater or upstream installer for this fork: they do not deliver our custom image through the verified hot-switch procedure.

For a synthetic smoke test, first ensure the manifest's pinned PostgreSQL/Redis images are already in the local image store and test port `18383` is free, then run `node smoke.mjs manifest.json`. The test creates a randomly named Compose project, generated disposable credentials, a dedicated bridge network, and independent empty volumes. Only the app's test port is published, on host loopback; the database and Redis ports are not published. The bridge permits public dependency/version lookups, but has no production-network attachment, production data, or real model credentials. The test verifies setup, login, embedded assets, runtime UID, restart, and session continuity, then removes only its own containers/network/volumes. This is not the old-database rehearsal or production readiness gate.

A new administrator in the empty test database must acknowledge the upstream compliance statement before accessing protected admin APIs. The smoke test verifies the expected `423 ADMIN_COMPLIANCE_ACK_REQUIRED` and does not accept terms. Binary version and full commit are checked offline. Test the real admin workflow and existing acknowledgement preservation during the old-data rehearsal; any required acceptance is a human decision. This guard is unchanged between the observed running source and `v0.2.12`.

## Build the Same Candidate

Requires committed, clean source; a local `v0.2.12` tag resolving to the manifest's upstream commit; Docker and Buildx; and network access for dependency installation. The checked-in source validation record must match the backend/frontend Git trees; a changed tree requires fresh qualification, not relabeling earlier results. Base image digests and pnpm are fixed in `deploy/local-upgrade/build-inputs.json`. Frozen frontend lockfile and Go module checksums are enforced. Alpine package repositories are still external inputs, so this is an auditable build recipe, not a promise of bit-for-bit reproducibility.

```sh
docker-buildx create --name sub2api-release-20261002 \
  --driver docker-container \
  --driver-opt memory=2560m,cpu-period=100000,cpu-quota=100000 \
  --buildkitd-config deploy/local-upgrade/buildkitd.toml colima --bootstrap
SUB2API_BUILDX=/opt/homebrew/bin/docker-buildx \
SUB2API_BUILDER=sub2api-release-20261002 \
  node deploy/local-upgrade/build-local.mjs
```

Reuse the named builder if it already exists, checking its actual container limits. Local build resources are recorded in `build-inputs.json`: a 2560MiB builder cap, 2048MiB Node heap, and Go compilation parallelism two with a 768MiB soft memory limit per Go process. A 2GiB builder and a 1664MiB Node heap were insufficient for the frontend typecheck. The script builds from a committed-source archive, exports to ignored `release/`, and imports only the candidate image to verify its identity. It refuses to overwrite a completed package; an interrupted build with identical inputs may be retried. It does not push images, start services, or change routes. Build outside the service host when possible; otherwise enforce resource limits and monitor the old site's latency, health, memory, and disk. Do not stop the old site to make room for a build.

## Upgrade From the Current Service

The observed local service is `0.2.4`, source commit `5de5e2bed035d43591a2e10e51f420ef6a84eb98`, at loopback port `18080`. Its source differs from the skin development base. Upgrade analysis must start from this running commit. The upstream target is `5106065716e494204fc0e8db16f68f6e9d576be0` (`v0.2.12`).

Seven new SQL migrations occur on this path; existing migration files were not modified in the inspected diff:

| Migration | Upgrade and rollback concern |
| --- | --- |
| `238_opencode_go_platform.sql` | Rebuilds platform CHECK constraints; assess table locks against live traffic. |
| `238_purge_unlimited_user_platform_quotas.sql` | Deletes all-null quota rows; check old-version semantics, not only schema. |
| `238b_content_moderation_engine_meta.sql` | Adds nullable engine metadata. |
| `239_channel_reasoning_effort_multipliers.sql` | Adds/backfills pricing columns and rewrites group pricing JSON, removing a consumed legacy key. Old pricing behavior must be tested. |
| `240_affiliate_ledger_operation_id.sql` | Adds operation IDs and a unique index; index creation is not concurrent. |
| `241_add_payment_order_bonus_amount.sql` | Adds a default-zero bonus amount. |
| `241_add_typesafe_platform.sql` | Rebuilds quota/route platform constraints; assess locks and old validation behavior. |

The release also invalidates previously issued password-reset links. Communicate this and test freshly issued links and atomic consumption. Database migration happens on candidate startup, before traffic is switched. The migration advisory lock only serializes migrations; it does not prove compatibility or eliminate table locks.

## Protected Rehearsal and Preflight

Run these helpers from the committed source checkout, with the exact candidate manifest. They are not deployment commands:

```sh
node deploy/local-upgrade/preflight.mjs /absolute/path/to/manifest.json
node deploy/local-upgrade/backup-private.mjs /Users/clawbotbot/Projects/sub2api-upgrade-private
node deploy/local-upgrade/rehearse-private.mjs /absolute/path/to/backup-DIRECTORY /absolute/path/to/manifest.json
node deploy/local-upgrade/test-audit.mjs
node deploy/local-upgrade/test-backend.mjs unit
node deploy/local-upgrade/test-backend.mjs integration
node deploy/local-upgrade/test-proxy.mjs /absolute/path/to/manifest.json
node deploy/local-upgrade/test-assets.mjs /absolute/path/to/manifest.json
```

Preflight is read-only: it checks immutable image identity, unchanged production container health, and an allowlisted aggregate inventory in a PostgreSQL read-only transaction. It never emits credentials or grants deployment approval. Secret-environment presence is not proof of effective file configuration; inspect actual JWT/TOTP settings privately before installing slots. General secret encryption and payment signing use the configured TOTP key, not a separate `SECRET_ENCRYPTION_KEY` variable.

Backup helpers place recovery data outside Git/Vault, with directory mode `0700` and file mode `0600`. `recovery-private.json` contains secrets and must never be printed, committed, or packaged. PostgreSQL is a consistent logical snapshot; Redis and mutable app data are separate snapshots, not a cross-store atomic backup. The backup manifest remains `restoreVerified: false`; successful restore evidence is in the separate rehearsal report for the exact image.

Rehearsal restores actual data onto independent PostgreSQL/Redis and separate app volumes, on an internal no-egress network without host ports. It checks business projections (including account credentials as hashes), seven expected migrations, old checksums, existing compliance, old sessions, admin reads, peer key writes, models and restart compatibility. Token refresh is disabled: this does not prove live account refresh or all background-job compatibility. Random project/volume ownership is checked; helpers have names and bounded private failure/state diagnostics so a Docker client timeout cannot silently orphan restore work.

The backend runner uses the upstream Go toolchain, bounded parallelism/memory, and an allowlisted environment without model credentials. It retains at most ten run directories and caps captured failure details at 4 MiB per report; successful test logs are discarded. Passing dependency integration tests does not count as passing real model tests that were intentionally skipped. The audit helper runs its optional PostgreSQL/Redis cases separately and requires zero skips.

The asset helper requires the checkout's frozen frontend development dependencies (JSDOM and TypeScript parsers). It discovers fingerprinted JS/CSS dependencies from the actual embedded builds, compares bytes and content types, and tests `haproxy-legacy-assets.cfg` with a GET/HEAD exact-path map. The legacy resource instance uses the exact old image in setup mode, UID 1000, a read-only root and empty temporary data, no production secrets/dependencies, no host port, and only an internal no-egress network. Only the proxy publishes an ephemeral loopback port. Old resource paths stay available after the old application asset fixture is stopped; setup/API/POST paths cannot reach the resource instance. Setup-mode test probes use `/` rather than `/health`. This is not live browser/API or full-media continuity evidence. Do not publish the resource instance or route an entire `/assets/` prefix to its setup server. The templates remain uninstalled; confirm forwarding trust, capacity and real browser behavior before use.

## Mixed-Version Restrictions

- During coexistence, set `GATEWAY_SCHEDULING_LEGACY_SNAPSHOT_COMPAT=true` on the candidate. The old image drops RPM and newer threshold fields from shared `sched:meta:*` projections; the local compatibility mode instead reads the complete `sched:acc:*` payload and rebuilds the current safe projection in memory. It does not change shared key formats, expose OAuth tokens to candidate-list consumers, or repair the old binary. Missing/corrupt full payloads take the existing miss/error path, never unsafe legacy metadata. Defaults remain unchanged. The extra Redis bytes/CPU must be included in live readiness; keep the mode for as long as an old writer can remain or return.
- The observed production inventory had zero enabled scheduled account tests, zero enabled channel checks, a disabled backup schedule and no active backup/restore operations. These are point-in-time checks, not permanent guarantees. Freeze those workflows during overlap: scheduled account tests/channel checks have only process-local exclusion, and the old backup writer does not participate in the new metadata writer lock/protection rules. Re-run preflight immediately before any shared-dependency installation or rollback.
- Password-reset token formats differ. Keep reset issuance/verification/consumption on one version, drain pending reset requests and communicate link invalidation. Do not randomly balance auth workflows or promise old-image rollback of new reset tokens. Verification-attempt counters also differ across versions.
- OAuth refresh and existing singleton jobs use distributed locks, but locks alone do not prove state/lease safety under real upstream calls. The isolated drill deliberately prevents account egress; controlled live refresh, counters, multi-turn state and billing still require separate evidence.

## Required Release Sequence

1. Record the old image ID, container ID, configuration revision, source/version, and current entry route. Create a private backup of PostgreSQL, required Redis state, configuration, encryption keys, and mutable application data. Restore it into an isolated rehearsal environment and prove that restoration works. Never put these files in this public fork or in the upgrade package.
2. Rehearse the old-to-new migration on an isolated copy. Capture duration and locks, compare quota/pricing/billing semantics and balances, verify restart idempotence, and run both old and new images against the migrated rehearsal data. Validate mixed-version Redis state and background jobs. OAuth refresh has distributed locking, but this does not establish safety for every scheduled task. If compatibility cannot be proven, do not attach the candidate to production dependencies; engineer a compatible staged migration first.
3. Introduce a stable HAProxy entry on a free loopback port, proposed `18380`, initially routing to the still-running old `18080`. The pinned image tested is `haproxy@sha256:8007effce89a08af0236b9529a0daab5b8b36fa939f4162f28201f1bf8731dbf`; `haproxy.cfg` is a template, not an installed production proxy. Test UI, auth, forwarding headers/trust, normal API, SSE, WebSocket, timeouts, and resource use through the actual entry. Migrate clients only after that entry works. A Tailscale Serve target change and original-port takeover require their own connection-preservation rehearsal; first entry migration is not automatically zero-interruption.
4. Only after the preceding gates pass, start the candidate in a separate application slot with the same production PostgreSQL/Redis and unchanged JWT/TOTP/encryption secrets. Keep slot installation/configuration directories separate; mutable business files must be safely accessible to both. Neither dependencies nor the old application are recreated. Verify migration locks and old-site business probes while the candidate starts.
5. Candidate readiness must pass three successive rounds: expected source/version, DB/Redis, existing login sessions, authorization failures, model listing, selected real low-rate gateway calls, SSE first token and end event, relevant WebSocket/multi-turn/tool flows, UI and lazy-loaded assets. Use an explicitly authorized test key/account and spending budget. A static `/health`, empty-database smoke test, or synthetic skin preview is insufficient.
6. Acquire a single release lock, validate the proxy configuration, and update the HAProxy runtime map to route new requests to the candidate, without proxy reload/restart. Read back the runtime route, verify responses through the entry, and atomically persist the map in the private directory for restart recovery. Disk/runtime disagreement blocks retirement and requires reconciliation while both slots stay alive. The admin socket must remain unpublished and local to the proxy container. Disable blind retries of non-idempotent POSTs. Continuously probe the new route and old in-flight work. Existing SSE/WebSocket connections stay with the old process.
7. Observe the new route for at least ten minutes and until business error rate, latency, billing, and async writes are acceptable. Keep the old process running until active requests, SSE/WebSocket sessions, and associated async persistence are explicitly zero. A fixed timer, health check, or TCP count alone is not drain proof. If requests do not drain, retain the old instance and investigate. The current application has a five-second SIGTERM shutdown timeout, so a longer Compose stop grace alone does not protect unfinished work.
8. After readiness, observation, and drain all pass, stop only the old application slot. Retain its immutable image and configuration for the agreed rollback window. PostgreSQL, Redis, and the stable entry remain running. Record image ID, checksums, migration outcome, route changes, probe/drain evidence, and rollback eligibility.

## Failure and Rollback

Before switch: keep the old route; a candidate failure must not stop the old site. If migration has already affected shared data, evaluate impact immediately rather than assuming the old route is unaffected.

After switch: change the runtime map back to the old slot only if rehearsal proves it remains correct with the currently migrated and newly written data, including any newly used features/auth/backup metadata. Persist and verify the route. Keep the new process alive to finish its existing requests. Do not restore a pre-upgrade snapshot into the live database during hot rollback; that would lose subsequent writes. If backward compatibility is not established, a forward repair or explicitly approved recovery procedure is required. Missing evidence means no production switch, not an automatic maintenance outage.

The proxy fixture has proved same-connection HTTP rerouting, a six-second old SSE, existing/new WebSockets, runtime rollback without process replacement, no POST replay after 500/transport failure, and persisted-route recovery after an isolated restart with drained connections. Its mock write counter explicitly is **not** real application drain proof. The running old binary exposes no complete per-instance request plus usage-worker plus billing-cache drain snapshot. Do not stop it based on time, TCP count, the fixture, or `/health`. The source cleanup stops usage and billing-cache workers in parallel, so absence of HTTP work alone does not establish persistence safety. Until actual drain proof exists, keep the old slot running and do not report the release as completed.

This procedure avoids a planned application-service gap after the stable entry is established. It does not provide host, Docker VM, proxy, or database high availability on a single Mac.
