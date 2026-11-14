# Sub2API 现网热切换：0.2.21 / 1712dcead2c0（Codex Desktop page-context / call_id）

## 批准
QH 已在 P0 会话亲自确认：「同意按 1712dcead2c0 在 macmini 热切换到 Sub2API 0.2.21」。
E0 合入 https://github.com/wo1fsea/sub2api/pull/3 后请 P0 做现网切流；E0 不在 macmini 上写。
QH 已批准本次切流写入 live compose 的 `services.app.image` 以及 upgrade state；不要再等第二次 activate GO。若出现会改 `.env`、数据库、或应用迁移 249/250 的路径，立刻停并写清 blocker，不要自行放宽。

## 目标
把 fork 分支 `codex/fix/image-allowlist-20261103` 的 merge commit 合入内容，经鉴定、linux/arm64 打包、备份、隔离演练、prepare、activate，切到 macmini 现网 `sub2api-current-app`。
本次只解决 Codex Desktop 的 page-context / call_id 问题。不要处理今天下午 16:16 的 OpenAI oauth 账号 #1 token 过期，也不要为此重启服务。

## 已核对的事实（2026-11-11 ~18:27 Asia/Taipei，P0 只读）
- 现网 revision `466dc86d2eec60c8d56398dcae627a3f1c375127`，image `sha256:ed98069e97165ce50a1286cd7707fa250c8b864e4651ab63cad0d3ce1e5b1655`，tag `sub2api-local:0.2.19-466dc86d2eec`，healthy；18480/18080 `/health` 均为 ok。切前再跑一次 `docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' sub2api-current-app` 记入 NOTES，勿沿用旧笔记。
- 部署目录 `/Users/clawbotbot/Projects/sub2api-local` 不是 git 仓；`.env` mtime 仍是 2026-09-24，不要读出或打印其中密钥，也不要改它。
- 当前 upgrade：`current-0.2.13/state.json` phase `active-old-retired`，`upgrade-0.2.19-466dc86d2eec` phase `active-verified`，备份 `/Users/clawbotbot/Projects/sub2api-upgrade-private/backup-Omp0Fv`。本轮要做**新的受保护备份**，不要覆盖或删除 `backup-Omp0Fv`。
- 工作树（本目录）：`/Users/clawbotbot/Projects/sub2api-0.2.21-cutover`，detached HEAD `1712dcead2c0ec299670f4c53833f111c0211bf1`（Merge PR #3，parents `466dc86d2` + `b22ad5763`，时间 2026-11-11 18:25:22 +0800）。不要用旧的 `c5ec507` 线。Factory QuotaWindowRecovery 与 image-allowlist 都还在这棵树上。
- 树内 `backend/cmd/server/VERSION` = `0.2.21`。`deploy/local-upgrade/build-inputs.json` 已是 0.2.21 / `v0.2.21` / upstreamCommit `10ba8f9b4dc2e6023d4a9879ab77b21841babd10`（已 fetch origin tag，且该 commit 是本 HEAD 祖先）。
- `deploy/local-upgrade/source-validation.json` **仍停在 0.2.19**（recordedDate 2026-11-05，backendTree `b4b25045…`，migrationsTree `ba0fd03a…`）。不重新鉴定的话 `build-local.mjs` 会拒绝出镜像。
- 本 HEAD 树：backend=`6fab116a1b194e7e0a1d89d3de4545467370aa0e`，frontend=`ea2cd82cf1aae491fe701874288b94ff8bb80b0e`，migrations=`e5e04ecb8116b6a626154bf399891d0ec89ebefd`。frontend 与 migrations 相对现网 466dc86d 都有变化，前端鉴定不能沿用 0.2.19 记录。
- 相对 466dc86d，新增迁移：`249_mcp_oauth.sql`、`249_add_usage_logs_api_key_cost_index_notx.sql`（CONCURRENTLY 索引）、`250_openai_cache_write_ttl.sql`。现网 `schema_migrations` 停在 `248_group_image_count_billing.sql`，这三条都还没打。
- 本树的 `rehearse-private-validation.mjs` / `upgrade-current.mjs` **只支持** `0.2.13→0.2.19` 或 `0.2.19→0.2.19`；`selectRehearsalMode('0.2.19','0.2.21')` 会直接抛错。P0 在 migrations_runner 里也没看到跳过 pending 迁移的开关；`ApplyMigrations` 会在启动时把嵌入的未应用 SQL 打进库。
- 数据盘约 16Gi 可用（约 92%）。构建前先评估空间；只清可回收构建垃圾，**禁止**删现网镜像、现网 volume、或 `backup-Omp0Fv`。docker.io / auth.docker.io DIRECT 已在 11-05 配过，需要拉基础镜像时沿用，不要改 Clash 以外的网络策略。

## 硬约束
1. 只改 image / compose / upgrade state。不要动 `.env`，不要动数据库（含禁止手工插入 `schema_migrations` 冒充已迁移）。
2. **不要让自动升级应用上游迁移 249/250**。隔离演练若会在副本上应用它们，可以观察，但不得把「应应用 249/250」写进可通向现网 activate 的脚本/模式。现网 activate 若会导致新容器启动时自动执行这三条，必须停在 blocker，不得激活。
3. 不要手填镜像 tag。`build-local.mjs` 会生成 `sub2api-local:<version>-<12-char HEAD>`。若鉴定需要改 `source-validation.json`（以及为支持「0.2.19→0.2.21 且零新增迁移」而改 upgrade 脚本），可在本工作树另作本地鉴定提交，**以鉴定后实际 HEAD 为准**；不要 amend 已经合入的 `1712dcea`，不要推 origin（Wei-Shaw），不要推公开 fork，除非 P0 另令。
4. 不要用 `c5ec507` 线，不要改现网客户端密钥，不要为 oauth #1 重启。
5. 升级脚本与源码在本工作树；现网 compose/state 在 `sub2api-local`。不要把 cwd 改成 `sub2api-local` 当源码仓。
6. 失败即停；回滚只用 `upgrade-current.mjs rollback MANIFEST`（只回 app）；保留新备份。
7. 不要打印密钥、token、密码。

## 建议步骤
1. 记录切前回滚 digest / revision / 18480+18080 health。
2. 重新做源码鉴定并更新 `source-validation.json`（backend/frontend/migrations tree、version 0.2.21、upstream v0.2.21/`10ba8f9b`、资格范围写清：page-context/call_id 合入，明确不应用 249/250）。按 `build-local.mjs` 要求把工作树弄干净后再打包。
3. 先解决演练/activate 路径：新增一种「0.2.19 → 0.2.21、newCount=0、现网库仍停在 248」的模式，并且必须能证明 0.2.21 进程启动后不会执行 249/250。若做不到，停在鉴定（或镜像已建成但未 rehearsed/activated）并写 blocker。
4. 若且仅若第 3 步有安全路径：`SUB2API_BACKUP_APP=sub2api-current-app node deploy/local-upgrade/backup-private.mjs /Users/clawbotbot/Projects/sub2api-upgrade-private` → `rehearse-private.mjs BACKUP MANIFEST` → `upgrade-current.mjs prepare MANIFEST BACKUP RESTORE_REPORT` → `upgrade-current.mjs activate MANIFEST` → `upgrade-current.mjs status MANIFEST`。
5. 切后确认：实际 image tag、digest、revision；18480/18080 healthy；`.env` mtime 未变；`schema_migrations` 仍无 249/250；写 NOTES 并摘要回 P0。

## 成功标准
- 现网跑的是鉴定后实际 HEAD 打出的 `sub2api-local:0.2.21-<12-char>`，health ok
- `.env` / 数据库未改；迁移 249/250 未应用到现网
- NOTES 写明 tag、digest、revision、备份路径、演练模式、迁移证据

## 失败
立即停；需要时 rollback；保留备份；向 P0 报告卡点，勿强推。
