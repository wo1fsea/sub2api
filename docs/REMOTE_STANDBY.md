# GetCodex Sub2API standby

The independent HK standby is live at `https://getcodex.pro/v1`. Both sites now serve the subscription-quota overview release, installed on 2026-10-08; the Mac mini remains primary at `https://openclaw-macmini-ts.tailff52e6.ts.net/v1`. Registration is disabled. Users, API keys and JWT/TOTP configuration originate from the 2026-10-07 snapshot described below. Each site's Neubrutalism appearance remains administrator-controlled: the primary currently uses light mode and HK dark mode, both with accent `#d4ff3f`. The site name remains the copied `MAC-MINI` label; the URL identifies this standby.

## Release and data identity

| Item | Verified value |
| --- | --- |
| Host | `ssh getcodex-prod`, Ubuntu 24.04.4, HK, amd64, 2 cores / 2 GB |
| Version | `0.2.13` |
| Package source | `12426d2b4c42154c30202440e591ff6da180ce50` |
| HK image | `sha256:14b5e773945b289e277a7c26a117135b4424b5a4fe4528b8c835213b621cac4e` |
| HK package | `release/sub2api_0.2.13_linux_amd64_12426d2b4c42.tar.gz` |
| HK activation | 2026-10-08 15:17:51 Asia/Shanghai (`2026-10-08T07:17:51.188Z`) |
| Primary application source | `12426d2b4c42154c30202440e591ff6da180ce50` |
| Primary image | `sha256:f5d3b1f8c7f8993589093ac19f9f1a622821d22dbcb9290854d908a0b07ad880` |
| Primary package | `release/sub2api_0.2.13_linux_arm64_12426d2b4c42.tar.gz` |
| Primary activation | 2026-10-08 15:19:22 Asia/Shanghai (`2026-10-08T07:19:22Z`) |
| Source equivalence | Both architectures use the same source commit; backend tree `43ea9a6742be05c2536f56d90d7b74d9870340b3`, frontend tree `c14f7d9bc5df622ed328b8d2357a4c0563fc0984` |

The quota feature, final packages, qualification and local hot replacement are recorded in [the current delivery](LOCAL_DELIVERY_QUOTA_0.2.13.md). The application upgrade preserved HK's existing data, proxy assignments, domain and standby roles; it did not copy a new primary database snapshot.

## Initial snapshot and deployment history — 2026-10-07

These identities describe the initial standby installation and its source snapshot, not the currently running application image.

| Item | Historical value |
| --- | --- |
| Initial HK package source | `3f4dda07db0d70cd46e174e2e8c6069d8db65b3b` |
| Initial HK image | `sha256:45d3faa673cb37fb3ad40a7e2f74e500b50366de0a4f1c521573a365505b6ac7` |
| Initial HK package | `release/sub2api_0.2.13_linux_amd64_3f4dda07db0d.tar.gz` |
| Primary source at initial installation | `3e364ac542d0463133adaebd6c1e01cc11fdfdd7` |
| Primary image at initial installation | `sha256:581ca60710bbd7762645d0cbd5355da832edf0ee2a30639b9a6b37826968e966` |
| Initial source equivalence | Backend and frontend Git trees matched between the primary and amd64 package; the later commit added deployment tooling |
| Snapshot | 2026-10-07 22:13:40 Asia/Shanghai, `sub2api-upgrade-private/backup-gQ10gb` |
| Complete restore | All 100 public tables, 197,804 rows; per-table counts and ordered row hashes matched the source dump before standby changes |
| Credentials catch-up | One Anthropic OAuth credential record copied from the already-refreshed primary at 23:10; no new refresh requested |

PostgreSQL 18.6, Redis 8.10.2 and Caddy use pinned images and independent volumes/passwords. The restored database is a consistent PostgreSQL snapshot; PostgreSQL, Redis and application-data archives are not a cross-store atomic snapshot. Restore verification predates local standby changes and validation traffic.

The initial 2026-10-07 deployment included a real host reboot: the kernel boot ID changed, the systemd startup job completed successfully at 23:18:42 Asia/Shanghai, all services recovered, and another real Responses stream completed at 23:22:06. This proves startup for the initial image. The 2026-10-08 release received the startup-configuration verification below, without a new host reboot.

## Outbound proxy policy

HK uses Sub2API's own HTTP proxy management. `Webshare-US` is bound to all 3 OpenAI and 2 Anthropic accounts, including the Anthropic-compatible commercial-provider account. The static residential exit was confirmed in the US. Direct fallback is disabled because HK direct OpenAI access returned 403. No HK Clash/TUN/Xray installation is required.

The Mac mini's attempted direct Webshare entry was deleted at the user's request; no local account binding changed and no relay was installed. Its existing router forwarding remains the outbound path. Do not infer that the proxy IDs or account routing should match across the two databases.

## Runtime and startup

- `/etc/sub2api/compose-private.json`: root-only configuration, mode 0600; directory 0700. Never commit it.
- `/etc/sub2api/state.json`: root-only deployment state, mode 0600.
- `/opt/sub2api/Caddyfile`, `/opt/sub2api/standby-mode.py`, `/opt/sub2api/releases/manifest.json`.
- Compose project `getcodex-sub2api`; containers `getcodex-sub2api-app`, `getcodex-sub2api-postgres`, `getcodex-sub2api-redis`, `getcodex-sub2api-caddy`.
- HTTPS exposes Caddy only. The app's diagnostic port is `127.0.0.1:18584`; PostgreSQL and Redis have no published ports. Logs are bounded to two 5 MB files per container.
- `getcodex-sub2api.service` is enabled and active. After the 2026-10-08 update, startup-configuration verification passed at 15:18:10 Asia/Shanghai (07:18:10 UTC), then again at 15:44:29 (07:44:29 UTC): the running app, protected Compose, deployment state and release manifest all pin the new HK image. Both checks completed a real `gpt-6-astra` Responses request with zero automatic retries; neither performed a host reboot.
- Caddy remained the same running container with the same start time (`2026-10-07T15:18:42.229333998Z`) and restart count 0. Its configuration was validated and gracefully reloaded during the application replacement.
- Standby disables background token refresh, usage cleanup and monitor aggregation. This does not suppress every on-demand OAuth refresh; keep routine business traffic on the primary until takeover and synchronization are agreed.

```sh
ssh getcodex-prod 'sudo -n systemctl status getcodex-sub2api.service --no-pager'
ssh getcodex-prod 'sudo -n docker ps --format "{{.Names}} {{.Status}}"'
ssh getcodex-prod 'sudo -n docker compose -p getcodex-sub2api --env-file /dev/null -f /etc/sub2api/compose-private.json config --quiet'
```

To restart the standby stack, use `sudo systemctl restart getcodex-sub2api.service` on HK. Do not replay database provisioning, retirement or cleanup scripts on the completed deployment. A new application release must again prove the candidate through a real upstream call before moving its public route.

## Verification and retirement

For the 2026-10-08 quota release, candidate, canonical-app and public-entry checks passed with the exact new image: health, existing administrator session, HK's saved appearance, quota API, compiled quota overview chunk, historical fingerprinted assets and real current-Codex `gpt-6-astra` SSE completion. Only the owned candidate container, volume and upload were removed after the promoted application passed its public checks. Previous immutable images and protected backups remain available for recovery.

Initial-deployment checks on 2026-10-07 passed: health, copied administrator login, version, copied dark theme (`#d4ff3f`), embedded assets, unauthorized settings write rejected, real current-Codex `gpt-6-astra` SSE with completed output, and session reuse after an application restart. HK's native Anthropic account passed `claude-sonnet-4-5-20250929`; the compatible account passed `glm-5.3`. The public login page visually displayed the customized logo and theme. These provider and restart results are historical initial-image evidence, not fresh certification of every provider for the quota release.

During the initial 2026-10-07 installation, public OpenAI checks completed before and after old-resource removal and after a complete server reboot, without automatic request retries. These short probes do not certify every model, client retry policy or a partially delivered stream's continuation. Local OpenAI remained functional after the local proxy rollback and during that HK restart work.

The former Subdock app/worker/Caddy/PostgreSQL containers, 3 volumes, 3 networks, old application images, PostgreSQL 17/build image, project/config/backup/staging directories, backup units and upload staging were removed only after validation. Former sale/worker/payment routes return 410. The new TLS volume is independent; no old Docker resource is required for startup.

Recoverable old sale data/config/history remain encrypted at `/Users/clawbotbot/Projects/sub2api-upgrade-private/getcodex-retired-Q6DKF0`. The archive was actually decrypted into isolated PostgreSQL 17, with 30 tables / 50 rows matching the original. The age identity is stored separately inside that protected local directory. Keep this archive and current Sub2API packages/backups; no secrets or runtime reports belong in Git.

## Manual takeover and synchronization boundary

This is a working snapshot standby, not continuous replication or automatic failover. Primary business changes after the 2026-10-07 22:13:40 Asia/Shanghai snapshot are not generally present; the one-time credential catch-up is the only later business-data copy. The 2026-10-08 application upgrade did not refresh that snapshot. Test requests produce small independent usage records on HK.

Before takeover, fence the Mac mini so it cannot accept business writes or refresh the same OAuth accounts. Then on HK:

```sh
sudo /opt/sub2api/standby-mode.py active --primary-fenced
```

Change the client's API base URL to `https://getcodex.pro/v1`; its copied API key remains usable. Check a real request after takeover. The acknowledgement flag records an operator decision; it cannot independently prove the Mac is fenced. For return to the Mac, first fence HK and migrate any new credentials/business writes back; do not overwrite them with the old Mac snapshot.

Next discuss a single-writer design. A short-term option is periodic consistent dumps restored into a separate standby database, verified and switched after preserving HK's site-specific proxy/domain settings. OAuth credential changes need prompt one-way catch-up. A longer-term logical-replication design must account for architecture differences, schema changes, site-specific fields and application validation writes on the subscriber. Do not assume that copying Redis, proxy IDs or whole settings rows gives safe active-active service. No ongoing synchronization schedule has been installed.

## Operator tools

Tools live in `deploy/remote-standby/`. They allow only the established host, protected output directories and named deployment targets; private responses remain in `sub2api-upgrade-private`.

For a subsequent application release, use the current hot-upgrade tool, not the first-install scripts:

```sh
node deploy/remote-standby/upgrade-current.mjs prepare AMD64_MANIFEST
# Only after an interrupted candidate-started preparation:
node deploy/remote-standby/upgrade-current.mjs resume-prepare PRIVATE_RELEASE_DIRECTORY
node deploy/remote-standby/upgrade-current.mjs activate PRIVATE_RELEASE_DIRECTORY
node deploy/remote-standby/upgrade-current.mjs status PRIVATE_RELEASE_DIRECTORY
node deploy/remote-standby/upgrade-current.mjs verify-boot PRIVATE_RELEASE_DIRECTORY
node deploy/remote-standby/upgrade-current.mjs rollback PRIVATE_RELEASE_DIRECTORY
```

Prepare retains the previous private Compose/state/Caddy configuration and takes a fresh backup of HK's own data. It loads the checksummed amd64 image and starts a separate candidate at loopback `18585`, sharing HK's existing dependencies with duplicate background work disabled. Activation proves copied login/session, shared theme, the quota API and compiled quota chunk, and a real current-Codex request before moving the public route. Caddy's validated configuration is updated in place and gracefully reloaded with SIGUSR1; its admin API is disabled. While the candidate serves, replace only the canonical application, prove it and route back. Persist the new image/release identity in the existing startup sources, retain old fingerprinted assets, and remove only owned candidate resources after successful promotion.

This preserves each site's database, domain, proxy bindings and background-role policy. It neither overwrites HK with a new Mac snapshot nor installs ongoing replication. Rollback restores application/configuration/route, never a pre-upgrade database over newer writes. Startup verification checks the enabled systemd job, actual running image and protected configuration; a configuration check alone is not evidence of a fresh host reboot.

Verification tunnels use independent foreground SSH connections. At most three connection attempts are permitted before HTTP/model work begins; a model POST is never automatically retried. Preparation resumption verifies the fresh backup, package hashes, unchanged old route and configuration, owned candidate, and retained assets before collecting new candidate proof. A completed verified rollback can be followed by a fresh preparation of the same revision only after the original configuration and resource cleanup are checked; the previous remote operation journal is archived intact. Failed activation attempts to save its exact step, journal and bounded private diagnostics before rollback; diagnostic or journal write failures do not prevent the rollback attempt.

Historical fingerprinted assets transfer as one bounded gzip archive, with macOS copyfile metadata disabled for that tar subprocess. HK verifies the archive checksum, complete expected file set, byte budgets, safe regular paths and every asset checksum before adding cache files. It rejects links, duplicates, missing or extra files and existing hash collisions. This replaces slow recursive SCP without weakening the old-browser asset checks. If a public new UI must be rolled back, reload that browser page: HK restores the old Caddy configuration, so a new-version lazy chunk that was never cached is not guaranteed to remain accessible after rollback.

`configure-webshare.mjs DIRECTORY hk` safely tests and binds HK; its default is HK. `sync-current-oauth.mjs DIRECTORY` performs a manual, scoped primary-to-HK catch-up through admin writes and raw credential readback. `verify-boot.mjs DIRECTORY PREVIOUS_BOOT_ID` checks actual host restart and automatic startup, waiting for systemd readiness rather than merely SSH availability. `verify.mjs` also restarts the application; run it only during a standby validation window. `activate.mjs` requires candidate proof; `cleanup.mjs` requires public proof plus an actually restored old archive.
