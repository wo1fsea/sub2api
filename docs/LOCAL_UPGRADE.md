# Sub2API Local Upgrade

This package is a Linux ARM64 release candidate combining upstream `v0.2.12` with our grayscale Clash skin. It is not approval to deploy. Packaging never changes the running service, production database, secrets, or traffic route. The Cursor experiment is excluded.

## Package Contents

- `image.tar`: Docker image including the compiled gateway and embedded frontend.
- `source.tar.gz`: committed source, without dependencies, secrets, runtime data, or database backups.
- `manifest.json`: version, full source and upstream commits, image ID, pinned build inputs, and outstanding production gates.
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

## Build the Same Candidate

Requires committed, clean source; a local `v0.2.12` tag resolving to the manifest's upstream commit; Docker and Buildx; and network access for dependency installation. Base image digests and pnpm are fixed in `deploy/local-upgrade/build-inputs.json`. Frozen frontend lockfile and Go module checksums are enforced. Alpine package repositories are still external inputs, so this is an auditable build recipe, not a promise of bit-for-bit reproducibility.

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

## Required Release Sequence

1. Record the old image ID, container ID, configuration revision, source/version, and current entry route. Create a private backup of PostgreSQL, required Redis state, configuration, encryption keys, and mutable application data. Restore it into an isolated rehearsal environment and prove that restoration works. Never put these files in this public fork or in the upgrade package.
2. Rehearse the old-to-new migration on an isolated copy. Capture duration and locks, compare quota/pricing/billing semantics and balances, verify restart idempotence, and run both old and new images against the migrated rehearsal data. Validate mixed-version Redis state and background jobs. OAuth refresh has distributed locking, but this does not establish safety for every scheduled task. If compatibility cannot be proven, do not attach the candidate to production dependencies; engineer a compatible staged migration first.
3. Introduce a stable Caddy entry on a free loopback port, proposed `18380`, initially routing to the still-running old `18080`. Test UI, auth, headers, normal API, SSE, WebSocket, timeouts, and resource use through it. Migrate clients only after that entry works. A Tailscale Serve target change and original-port takeover require their own connection-preservation rehearsal; first entry migration is not automatically zero-interruption.
4. Only after the preceding gates pass, start the candidate in a separate application slot with the same production PostgreSQL/Redis and unchanged JWT/TOTP/encryption secrets. Keep slot installation/configuration directories separate; mutable business files must be safely accessible to both. Neither dependencies nor the old application are recreated. Verify migration locks and old-site business probes while the candidate starts.
5. Candidate readiness must pass three successive rounds: expected source/version, DB/Redis, existing login sessions, authorization failures, model listing, selected real low-rate gateway calls, SSE first token and end event, relevant WebSocket/multi-turn/tool flows, UI and lazy-loaded assets. Use an explicitly authorized test key/account and spending budget. A static `/health`, empty-database smoke test, or synthetic skin preview is insufficient.
6. Acquire a single release lock, validate the proxy configuration, and use a smooth reload to route new requests to the candidate. Do not restart the proxy. Disable blind retries of non-idempotent POSTs. Check the actual serving version through the stable entry and continuously probe both the new route and old in-flight work. Existing SSE/WebSocket connections stay with the old process.
7. Observe the new route for at least ten minutes and until business error rate, latency, billing, and async writes are acceptable. Keep the old process running until active requests, SSE/WebSocket sessions, and associated async persistence are explicitly zero. A fixed timer, health check, or TCP count alone is not drain proof. If requests do not drain, retain the old instance and investigate. The current application has a five-second SIGTERM shutdown timeout, so a longer Compose stop grace alone does not protect unfinished work.
8. After readiness, observation, and drain all pass, stop only the old application slot. Retain its immutable image and configuration for the agreed rollback window. PostgreSQL, Redis, and the stable entry remain running. Record image ID, checksums, migration outcome, route changes, probe/drain evidence, and rollback eligibility.

## Failure and Rollback

Before switch: keep the old route; a candidate failure must not stop the old site. If migration has already affected shared data, evaluate impact immediately rather than assuming the old route is unaffected.

After switch: smooth-reload back to the old slot only if rehearsal proves it remains correct with the currently migrated and newly written data. Keep the new process alive to finish its existing requests. Do not restore a pre-upgrade snapshot into the live database during hot rollback; that would lose subsequent writes. If backward compatibility is not established, a forward repair or explicitly approved recovery procedure is required. Missing evidence means no production switch, not an automatic maintenance outage.

This procedure avoids a planned application-service gap after the stable entry is established. It does not provide host, Docker VM, proxy, or database high availability on a single Mac.
