# GetCodex Sub2API standby

The independent HK standby is live at `https://getcodex.pro/v1` as of 2026-10-07. The Mac mini remains primary at `https://openclaw-macmini-ts.tailff52e6.ts.net/v1`. Registration is disabled. Existing users, API keys, JWT/TOTP configuration and the administrator-managed dark Neubrutalism appearance were copied from production. The site name remains the copied `MAC-MINI` label; the URL identifies this standby.

## Release and data identity

| Item | Verified value |
| --- | --- |
| Host | `ssh getcodex-prod`, Ubuntu 24.04.4, HK, amd64, 2 cores / 2 GB |
| Version | `0.2.13` |
| Package source | `3f4dda07db0d70cd46e174e2e8c6069d8db65b3b` |
| Image | `sha256:45d3faa673cb37fb3ad40a7e2f74e500b50366de0a4f1c521573a365505b6ac7` |
| Package | `release/sub2api_0.2.13_linux_amd64_3f4dda07db0d.tar.gz` |
| Primary application source | `3e364ac542d0463133adaebd6c1e01cc11fdfdd7` |
| Primary image | `sha256:581ca60710bbd7762645d0cbd5355da832edf0ee2a30639b9a6b37826968e966` |
| Source equivalence | Backend and frontend Git trees match between primary and amd64 package; the later commit adds deployment tooling |
| Snapshot | 2026-10-07 22:13:40 Asia/Shanghai, `sub2api-upgrade-private/backup-gQ10gb` |
| Complete restore | All 100 public tables, 197,804 rows; per-table counts and ordered row hashes matched the source dump before standby changes |
| Credentials catch-up | One Anthropic OAuth credential record copied from the already-refreshed primary at 23:10; no new refresh requested |

PostgreSQL 18.6, Redis 8.10.2 and Caddy use pinned images and independent volumes/passwords. The restored database is a consistent PostgreSQL snapshot; PostgreSQL, Redis and application-data archives are not a cross-store atomic snapshot. Restore verification predates local standby changes and validation traffic.

## Outbound proxy policy

HK uses Sub2API's own HTTP proxy management. `Webshare-US` is bound to all 3 OpenAI and 2 Anthropic accounts, including the Anthropic-compatible commercial-provider account. The static residential exit was confirmed in the US. Direct fallback is disabled because HK direct OpenAI access returned 403. No HK Clash/TUN/Xray installation is required.

The Mac mini's attempted direct Webshare entry was deleted at the user's request; no local account binding changed and no relay was installed. Its existing router forwarding remains the outbound path. Do not infer that the proxy IDs or account routing should match across the two databases.

## Runtime and startup

- `/etc/sub2api/compose-private.json`: root-only configuration, mode 0600; directory 0700. Never commit it.
- `/etc/sub2api/state.json`: root-only deployment state, mode 0600.
- `/opt/sub2api/Caddyfile`, `/opt/sub2api/standby-mode.py`, `/opt/sub2api/releases/manifest.json`.
- Compose project `getcodex-sub2api`; containers `getcodex-sub2api-app`, `getcodex-sub2api-postgres`, `getcodex-sub2api-redis`, `getcodex-sub2api-caddy`.
- HTTPS exposes Caddy only. The app's diagnostic port is `127.0.0.1:18584`; PostgreSQL and Redis have no published ports. Logs are bounded to two 5 MB files per container.
- `getcodex-sub2api.service` is enabled. A real host reboot changed the kernel boot ID; the systemd startup job completed successfully at 23:18:42, all services recovered, and a real Responses stream completed again at 23:22:06.
- Standby disables background token refresh, usage cleanup and monitor aggregation. This does not suppress every on-demand OAuth refresh; keep routine business traffic on the primary until takeover and synchronization are agreed.

```sh
ssh getcodex-prod 'sudo -n systemctl status getcodex-sub2api.service --no-pager'
ssh getcodex-prod 'sudo -n docker ps --format "{{.Names}} {{.Status}}"'
ssh getcodex-prod 'sudo -n docker compose -p getcodex-sub2api --env-file /dev/null -f /etc/sub2api/compose-private.json config --quiet'
```

To restart the standby stack, use `sudo systemctl restart getcodex-sub2api.service` on HK. Do not replay database provisioning, retirement or cleanup scripts on the completed deployment. A new application release must again prove the candidate through a real upstream call before moving its public route.

## Verification and retirement

Candidate and public checks passed: health, copied administrator login, version, shared dark theme (`#d4ff3f`), embedded assets, unauthorized settings write rejected, real current-Codex `gpt-6-astra` SSE with completed output, and session reuse after an application restart. HK's native Anthropic account passed `claude-sonnet-4-5-20250929`; the compatible account passed `glm-5.3`. The public login page visually displayed the customized logo and theme.

Public OpenAI checks completed before and after old-resource removal and after a complete server reboot, without automatic request retries. These short probes do not certify every model, client retry policy or a partially delivered stream's continuation. Local OpenAI remained functional after the local proxy rollback and during HK restart work.

The former Subdock app/worker/Caddy/PostgreSQL containers, 3 volumes, 3 networks, old application images, PostgreSQL 17/build image, project/config/backup/staging directories, backup units and upload staging were removed only after validation. Former sale/worker/payment routes return 410. The new TLS volume is independent; no old Docker resource is required for startup.

Recoverable old sale data/config/history remain encrypted at `/Users/clawbotbot/Projects/sub2api-upgrade-private/getcodex-retired-Q6DKF0`. The archive was actually decrypted into isolated PostgreSQL 17, with 30 tables / 50 rows matching the original. The age identity is stored separately inside that protected local directory. Keep this archive and current Sub2API packages/backups; no secrets or runtime reports belong in Git.

## Manual takeover and synchronization boundary

This is a working snapshot standby, not continuous replication or automatic failover. Business changes after 22:13:40 are not generally present; the one-time credential catch-up is the only later business-data copy. Test requests produce small independent usage records on HK.

Before takeover, fence the Mac mini so it cannot accept business writes or refresh the same OAuth accounts. Then on HK:

```sh
sudo /opt/sub2api/standby-mode.py active --primary-fenced
```

Change the client's API base URL to `https://getcodex.pro/v1`; its copied API key remains usable. Check a real request after takeover. The acknowledgement flag records an operator decision; it cannot independently prove the Mac is fenced. For return to the Mac, first fence HK and migrate any new credentials/business writes back; do not overwrite them with the old Mac snapshot.

Next discuss a single-writer design. A short-term option is periodic consistent dumps restored into a separate standby database, verified and switched after preserving HK's site-specific proxy/domain settings. OAuth credential changes need prompt one-way catch-up. A longer-term logical-replication design must account for architecture differences, schema changes, site-specific fields and application validation writes on the subscriber. Do not assume that copying Redis, proxy IDs or whole settings rows gives safe active-active service. No ongoing synchronization schedule has been installed.

## Operator tools

Tools live in `deploy/remote-standby/`. They allow only the established host, protected output directories and named deployment targets; private responses remain in `sub2api-upgrade-private`.

`configure-webshare.mjs DIRECTORY hk` safely tests and binds HK; its default is HK. `sync-current-oauth.mjs DIRECTORY` performs a manual, scoped primary-to-HK catch-up through admin writes and raw credential readback. `verify-boot.mjs DIRECTORY PREVIOUS_BOOT_ID` checks actual host restart and automatic startup, waiting for systemd readiness rather than merely SSH availability. `verify.mjs` also restarts the application; run it only during a standby validation window. `activate.mjs` requires candidate proof; `cleanup.mjs` requires public proof plus an actually restored old archive.
