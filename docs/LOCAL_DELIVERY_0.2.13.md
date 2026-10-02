# Local delivery: 0.2.13

The original HTTPS entry was activated at **2026-10-03 01:27:43 Asia/Shanghai** (`2026-10-02T17:27:43.021Z`). It now serves upstream `v0.2.13` with **Restrained Neubrutalism**, preserving grayscale diagonal chart hatches and icons. The displayed application version is exactly `0.2.13`. A forced update check returned current/latest `0.2.13`, `has_update:false`, with no warning. Future legitimate upstream update notifications remain enabled.

## Immutable application identity

| Item | Value |
| --- | --- |
| Upstream | `v0.2.13`, `3040209f205472038c1ba745a1bedd2edd9053b1` |
| Application source | `e4f96ee3f5fd11047a6817455964c3456cb07929` |
| Branch / checkout | `codex/feat/restrained-neubrutalism`, `/Users/clawbotbot/Projects/sub2api-neubrutalism` |
| Image | `sub2api-local:0.2.13-e4f96ee3f5fd` |
| Imported image ID | `sha256:145ba95c309d12c854d802075272c3358f125a0b8f11ef9bcf248f49a7c07e6c` |
| Image config digest | `sha256:55c75113e51b2ec1d651beee805169deb2ccf8caedaa580843c8b2cd44d7108a` |
| Package | `release/sub2api_0.2.13_linux_arm64_e4f96ee3f5fd.tar.gz`, 54,543,148 bytes |
| Package SHA256 | `444ff699e3068b6591aac2039ca224a915d4785929a4f6ec5a9507812e0563ed` |

Both the outer digest and all seven package-content digests passed. Build uses committed clean source, pinned base images and pnpm 9.15.9, a frozen frontend lockfile and bounded BuildKit/Node/Go resources. The builder is stopped, with its cache retained. Final host/Docker disk checks showed approximately 38GiB / 12GB available. No Docker/Colima restart or broad pruning was performed.

Deployment tools were corrected **after** application packaging in commit `c7b5ccb2aea898899000c5ff3c704b3af8156423`, which has been pushed and read back from the fork. This does not change the embedded application source SHA. Use the current checkout's `release-next.mjs`, including that fix, rather than the older helper in the package's source archive. The package is an immutable application/image artifact; it is not a standalone automatic installer. Its candidate-time manifest remains unchanged; this document records actual activation.

## Evidence

- Frontend: fresh final full suite 2,605 passed, typecheck, full lint and production build passed. No dependency/lockfile changes. Backend: Go 1.27.0 unit 57 packages / 21,859 passed / 18 conditional skips; integration 51 packages / 13,567 passed / 16 conditional skips; golangci-lint 2.13.0, zero issues. Conditional provider/plugin/audit skips do not certify real providers.
- Browser inspection: warm paper/ink, sparse lime, grayscale hatches, two dashboard text tones in each appearance mode, original fallback, independent dark mode, keyboard activation, persisted appearance, home, date menu, ranking and unsaved user dialog. Current embedded-browser viewport remained 1280x720 despite the resize request, so fresh 983px/mobile visual certification is not claimed. Preference migration/cross-tab behavior is covered by unit tests. Screenshots remain ignored/local.
- Exact-image smoke passed: binary version/full source, isolated empty DB/Redis, nonroot runtime, login/session/401, existing compliance gate without accepting terms, embedded assets, restart and session continuity. Its disposable project/volumes were removed.
- Fresh protected current-app backup `backup-FMpj1H` was restored onto independent no-egress DB/Redis and separate app volumes. **Zero new migrations**, unchanged prior checksums/business projections, existing JWT/compliance, both admin reads, peer synthetic key writes/model discovery and both restarts passed. The isolated rehearsal was removed; backup and compact private report remain. This is not a cross-store atomic snapshot.
- Actual old/new resource drill passed for 179 `.2` and 179 new fingerprinted JS/CSS dependencies. The live new entry then verified the **328-path union** of `0.2.4` and `.2` assets against the retained previous entry, byte-for-byte. GET/HEAD-only exact-path routing keeps API/POST/unknown paths out of the resource bridge.
- The first candidate start stayed in installation mode because the new helper omitted app-data initialization. Health returned 404; the previous entry remained active and healthy. The helper now restores installed config/marker only into the candidate's independent volume, guards against overwriting an installed candidate, and supports resuming a failed pre-activation prepare. The corrected prepare passed: `needs_setup:false`, healthy, restart count 0. Shared DB/Redis were not restored or recreated.

Two actual Responses SSE calls used the current Codex key/model `gpt-6-astra`, each with max output 128 and zero automatic retries:

| Probe | Total / first token | Usage | Result |
| --- | --- | --- | --- |
| Candidate at `18482`, 01:24:52 | 5112 / 4885 ms | 24 input / 5 output | HTTP 200, actual OK, completed |
| Original HTTPS entry, 01:27:42 | 5046 / 4787 ms | 24 input / 5 output | HTTP 200, green marker, actual OK, completed |

Across the switch, **89 sampled original-HTTPS health checks** from 01:27:35 to 01:28:20 all passed. This is sampled availability evidence, not a guarantee that every client connection was uninterrupted. No POST was replayed and lossless continuation of a partially delivered stream is not promised.

## Running entry and continuity

- Original API: `https://openclaw-macmini-ts.tailff52e6.ts.net/v1`; Tailscale HTTPS 443 → `http://127.0.0.1:18480` → green. HTTPS 8443 → `7777` is unchanged.
- Candidate `sub2api-green-v0213`: container `055da4e89b9a4427ece4509085bd13ac05e51ca3196796022d9ffc83f0a3c5db`, healthy, restart count 0, independent app data, direct loopback `18482`.
- New ingress: `sub2api-release-v0213-ingress-1`, container `22ce08fc311bba07de9b4ea1bf3cd48c13ec5af85b9f84b15d3031c4876a8870`. Runtime/disk map are both green; actual public version is `0.2.13`.
- Previous `.2` instance/entry `18282`/`18380` remain healthy and retain their original startup and restart count 0. The `0.2.4` instance at `18080` still owns refresh/cleanup/monitor-v2 aggregation. These roles are disabled in both newer instances. Retain legacy scheduler compatibility and freeze scheduled account tests, channel checks and backup schedules during coexistence.
- Private Compose/state: `/Users/clawbotbot/Projects/sub2api-local/releases/v0.2.13`, directory 0700/files 0600. HAProxy mounts only its secret-free `ingress/` directory. Secrets, backup, logs and screenshots are excluded from Git/Vault.

```sh
cd /Users/clawbotbot/Projects/sub2api-neubrutalism
node deploy/local-upgrade/release-next.mjs status
# Rollback first proves the previous entry can complete a real model request:
node deploy/local-upgrade/release-next.mjs rollback
```

Rollback moves only traffic, retains data and instances, and preserves 8443. A production rollback was not performed. Hermes and other clients still configured for direct `18080` remain on `0.2.4`; no client configuration was silently changed.

For the next release, create a separate development worktree, retain this operational checkout, fetch/merge the latest stable tag, inspect migrations and dependency changes, align VERSION/build inputs to the published version and repeat source/image/current-data/real-call checks. The helper pins this particular previous/candidate pair; revise the next release plan rather than blindly reusing its prepare command. Before accumulating another release, plan background-role handover and consolidation of the retained entries/assets. Do not stop the background owner or use the old single-instance Compose upgrade command as a cleanup step.
