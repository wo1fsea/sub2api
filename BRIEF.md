# Sub2API 现网热切换：0.2.21 / a8314a689286（248 schema 兼容 + page-context / call_id）

## 批准
QH 已在 P0 会话亲自确认：「同意按 a8314a689286 在 macmini 热切换到 Sub2API 0.2.21」。
此前按 1712dcead2c0 的切流已因迁移 249/250 硬阻断、未激活。本次是新合入点 [PR #5](https://github.com/wo1fsea/sub2api/pull/5)。
QH 已批准本次切流写入 live compose 的 `services.app.image` 以及 upgrade state；不要再等第二次 activate GO。若出现会改 `.env`、数据库、或应用迁移 249/250 的路径，立刻停并写清 blocker，不要自行放宽。

## 目标
把生产分支 `codex/fix/image-allowlist-20261103` 的 merge commit `a8314a689286dfac8d26b017e2b853d8335c19bb` 经鉴定、linux/arm64 打包、备份、隔离演练、prepare、activate，切到 macmini 现网 `sub2api-current-app`。
目标仍是 Codex Desktop 的 page-context / call_id，并在现网 248 schema 上走兼容路径。不要处理今天下午/稍早的 OpenAI oauth 账号 #1 token 过期，也不要为此重启或重登。

## 已核对的事实（2026-11-11 ~23:22 Asia/Singapore，P0 只读）
- 现网 revision `466dc86d2eec60c8d56398dcae627a3f1c375127`，image `sha256:ed98069e97165ce50a1286cd7707fa250c8b864e4651ab63cad0d3ce1e5b1655`，tag `sub2api-local:0.2.19-466dc86d2eec`，healthy；18480/18080 `/health` 均为 ok。StartedAt `2026-11-08T08:53:42.616998344Z`（= 2026-11-08 16:53:42 Asia/Singapore），RestartCount=6。切前再跑一次 `docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' sub2api-current-app` 记入 NOTES，勿沿用旧笔记。
- 部署目录 `/Users/clawbotbot/Projects/sub2api-local` 不是 git 仓；`.env` mtime 仍是 2026-09-24T18:02:14+0800，size 605，权限 0600，SHA256 `63503f4f21908be7b28ba9686c109e20498cb489ef429a9f8277c42d08a0bc14`。不要读出或打印其中密钥，也不要改它。
- 当前 upgrade：`current-0.2.13/state.json` phase `active-old-retired`，`upgrade-0.2.19-466dc86d2eec` phase `active-verified`，备份 `/Users/clawbotbot/Projects/sub2api-upgrade-private/backup-Omp0Fv`。指纹：compose-private.json `cb98c898…` / state.json `4980a4a2…`；upgrade compose `fb241b82…` / state `4a8dc232…`。本轮要做**新的受保护备份**，不要覆盖或删除 `backup-Omp0Fv`。
- 工作树（本目录）：`/Users/clawbotbot/Projects/sub2api-0.2.21-a8314a`，detached HEAD `a8314a689286dfac8d26b017e2b853d8335c19bb`（Merge PR #5，parents `1712dcead2c0` + `d6229bd54d1d`，时间 2026-11-11 20:37:31 +0800）。不要用旧的 `c5ec507` 线，也不要复用旧工作树 `/Users/clawbotbot/Projects/sub2api-0.2.21-cutover`（仍停在 1712dcea 的阻断 NOTES）。Factory QuotaWindowRecovery 与 image-allowlist 都还在这棵树上。
- 树内 `backend/cmd/server/VERSION` = `0.2.21`。`deploy/local-upgrade/build-inputs.json` 已是 0.2.21 / `v0.2.21` / upstreamCommit `10ba8f9b4dc2e6023d4a9879ab77b21841babd10`。
- `deploy/local-upgrade/source-validation.json` **仍停在 0.2.19**（recordedDate 2026-11-05，backendTree `b4b25045…`，frontendTree `6a3c4283…`，migrationsTree `ba0fd03a…`）。不重新鉴定的话 `build-local.mjs` 会拒绝出镜像。
- 本 HEAD 树：backend=`94629c84797fc066a407f00e0dac9440f75a228e`，frontend=`ea2cd82cf1aae491fe701874288b94ff8bb80b0e`（与 1712dcea 相同），migrations=`e5e04ecb8116b6a626154bf399891d0ec89ebefd`（路径 `backend/migrations`，与 1712dcea 相同；相对现网 466dc86d 的 `ba0fd03a…` 仍多出 249/250 三个 SQL 和对应测试）。
- 现网 `schema_migrations` 仍 299 条，最后是 `248_group_image_count_billing.sql`，没有 249/250。
- 相对 1712dcea，本合入改的是后端兼容层（约 15 个文件，含 `migrations_runner.go`、`schema_compat.go` 及定价/用量/MCP 路径），**迁移 SQL 文件集合未再变化**。
- 代码里可见的热切换跳过逻辑（P0 只读，须在演练中证明，不能只凭读代码放行）：
  - `hotCutoverDeferredMigrations` 包含 `249_add_usage_logs_api_key_cost_index_notx.sql`、`249_mcp_oauth.sql`、`250_openai_cache_write_ttl.sql`。
  - `shouldDeferHotCutoverMigrations`：已应用账本非空、且这三项尚未入账时返回 true；空库（fresh install）返回 false，仍会打 249/250。
  - `applyMigrationsFS` 在 defer 为 true 且文件尚未 applied 时 `continue` 跳过，并打 log「skipping migration … 249/250 are not applied during hot cutover」。
  - `schema_compat.go` 在运行时探测 `cache_creation_30m_tokens` / `cache_creation_12h_tokens` / `cache_write_12h_price` 与 MCP OAuth 表是否存在，按 248 schema 收窄查询。
- 本树的 `rehearse-private-validation.mjs` / `upgrade-current.mjs` **仍只支持** `0.2.13→0.2.19` 或 `0.2.19→0.2.19`；测试里 `selectRehearsalMode('0.2.19','0.2.21')` 仍会抛错。要通向 activate，必须先有一条已证明的「0.2.19→0.2.21、现网/演练库仍停在 248、249/250 未被应用」的演练模式。可按同版本演练的精神处理：断言 **已应用/入账的文件名与 checksum 集合（到 248 为止）不变**，并且 post-248 三个文件保持未应用。不要把「嵌入树里多了 249/250 文件」误写成必须应用到现网；也不要新增会打 249/250 的 mode。隔离演练必须用现网库的副本（非空账本），不要用空库当 activate 依据——空库仍会打 249/250。
- 数据盘约 15Gi 可用（约 93%）。构建前先评估空间；只清可回收构建垃圾，**禁止**删现网镜像、现网 volume、或 `backup-Omp0Fv`。docker.io / auth.docker.io DIRECT 已在 11-05 配过，需要拉基础镜像时沿用，不要改 Clash 以外的网络策略。

## 硬约束
1. 只改 image / compose / upgrade state。不要动 `.env`，不要动数据库（含禁止手工插入 `schema_migrations` 冒充已迁移）。
2. **不要让自动或手动升级应用上游迁移 249/250**。隔离演练必须证明进程启动后这三条仍未入账、库结构仍是 248。若做不到，停在 blocker，不得激活。
3. 不要手填镜像 tag。`build-local.mjs` 会生成 `sub2api-local:<version>-<12-char HEAD>`。若鉴定需要改 `source-validation.json`（以及为支持「0.2.19→0.2.21 且不应用 249/250」而改 upgrade 脚本），可在本工作树另作本地鉴定提交，**以鉴定后实际 HEAD 为准**；不要 amend 已经合入的 `a8314a689286`，不要推 origin（Wei-Shaw），不要推公开 fork，除非 P0 另令。若鉴定的就是这次 merge commit，期望 tag 形如 `sub2api-local:0.2.21-a8314a689286`，但仍以实际 HEAD 为准。
4. 不要用 `c5ec507` 线，不要改现网客户端密钥，不要为 oauth #1 重启或重登。
5. 升级脚本与源码在本工作树；现网 compose/state 在 `sub2api-local`。不要把 cwd 改成 `sub2api-local` 当源码仓。
6. 失败即停；回滚只用 `upgrade-current.mjs rollback MANIFEST`（只回 app）；保留新备份。
7. 不要打印密钥、token、密码。

## 建议步骤
1. 记录切前回滚 digest / revision / 18480+18080 health。
2. 重新做源码鉴定并更新 `source-validation.json`（backend/frontend/migrations tree、version 0.2.21、upstream v0.2.21/`10ba8f9b`、资格范围写清：page-context/call_id 合入 + 248 schema 兼容，明确不应用 249/250）。按 `build-local.mjs` 要求把工作树弄干净后再打包。
3. 先解决演练/activate 路径：在不新增「应打 249/250」mode 的前提下，证明 0.2.21 进程在现网库副本上启动后会跳过这三条，兼容路径可用，账本仍停在 248。若做不到，停在鉴定（或镜像已建成但未 rehearsed/activated）并写 blocker。
4. 若且仅若第 3 步有安全路径：`SUB2API_BACKUP_APP=sub2api-current-app node deploy/local-upgrade/backup-private.mjs /Users/clawbotbot/Projects/sub2api-upgrade-private` → `rehearse-private.mjs BACKUP MANIFEST` → `upgrade-current.mjs prepare MANIFEST BACKUP RESTORE_REPORT` → `upgrade-current.mjs activate MANIFEST` → `upgrade-current.mjs status MANIFEST`。
5. 切后确认：实际 image tag、digest、revision；18480/18080 healthy；`.env` mtime/SHA256 未变；`schema_migrations` 仍无 249/250；写 NOTES 并摘要回 P0。

## 成功标准
- 现网跑的是鉴定后实际 HEAD 打出的 `sub2api-local:0.2.21-<12-char>`，health ok
- `.env` / 数据库未改；迁移 249/250 未应用到现网
- NOTES 写明 tag、digest、revision、备份路径、演练模式、迁移跳过与 248 兼容的证据

## 失败
立即停；需要时 rollback；保留备份；向 P0 报告卡点，勿强推。

---

# 续做授权（2026-11-11 ~23:44 Asia/Singapore）

QH 亲口批准（本 P0 聊天 widget 回复，原话）：

「同意扩大现网恢复程序兼容范围，让它接受 0.2.21，然后再打包、做新备份并用现网库副本演练」

这是同一项热切换任务的追加口径，不是新任务。继续使用本工作树与 tab `cutover-0.2.21-a8314a`。

## 现网只读复核（P0，本次发令前）

- 容器仍按 digest pin 跑：`sha256:ed98069e97165ce50a1286cd7707fa250c8b864e4651ab63cad0d3ce1e5b1655`，healthy，RestartCount=6，StartedAt 仍是 `2026-11-08T08:53:42.616998344Z`（2026-11-08 16:53:42 Asia/Singapore）。未在本轮重启。
- 工作树 detached HEAD 现为本地鉴定提交 `9a09bccd70079b28d77a98870bcd09e335bf60f3`（parent 仍是批准的合入点 `a8314a689286dfac8d26b017e2b853d8335c19bb`）。该本地提交只含鉴定 NOTES 与 rehearse/upgrade/source-validation 门禁，未 push 任何 remote。不要 amend `a8314a689286`，也不要 push origin / fork，除非 P0 后来说可以。
- 窗 `t29` / `codex-plan-021-a8314a` 仍 live、status done、turn 2。本次是续做，不要另开 tab。

## 本轮允许做的事（按顺序）

1. **扩大现网恢复程序兼容范围，让它接受 0.2.21。**
   - 现网实际路径（以你 NOTES 为准，先再只读核对后再改）：`/Library/LaunchDaemons/net.clawbotbot.sub2api-recovery.plist` 每 60 秒执行 `/Library/Application Support/Sub2API Recovery/launchd-recovery.mjs`，该 dispatcher 固定调用 `/Users/clawbotbot/Projects/sub2api-neubrutalism/deploy/local-upgrade/service-recovery.mjs`。
   - 改的是这套**现网正在用的**恢复程序（以及它为接受 0.2.21 所必需的 manifest 路径校验 / `supportedVersions` / `releasePin` / `assertVersion`）。不要改错树，也不要只改本工作树里一份没被 launchd 调用的副本就算完成。
   - 范围只够让 0.2.21 被接受；必须继续兼容 0.2.13 和 0.2.19。不要改无关恢复行为，不要改 plist 指向，除非只读证明不改就无法接受 0.2.21。
   - 改前先备份将改的文件（不要动或覆盖 `backup-Omp0Fv`）。改后做只读复现：0.2.19 仍 accepted=true，0.2.21 变为 accepted=true，不再报 `Unsupported release version`。不要借这次改动去 boot/重启/触发一次真实恢复。
   - 若写 `/Library/...` 需要提权且做不到，停在卡点并写入 NOTES，不要绕过，也不要放宽其他约束。

2. **然后才打包** 0.2.21 镜像。tag 用 `build-local.mjs` 按实际 HEAD 生成，不要手填。报告实际 tag / digest。本地鉴定提交 `9a09bcc` 可以留作工作树 HEAD（若打包就基于它），但合入点 ident 仍是 `a8314a689286` / PR #5。

3. **做一份新的受保护备份。** 保留旧备份 `backup-Omp0Fv`，不要删、不要覆盖。

4. **用现网库副本做隔离演练。** 必须是非空、完整的现网 248 账本副本（299 条，停在 `248_group_image_count_billing.sql`）。证明启动/重启都不会应用 249/250 那三个文件，对应表/列/索引保持缺席。空库/新库仍会应用 249/250，不能成为允许 activate 的路径。不要新增会应用 249/250 的 rehearsal mode。

5. **仅当演练证明安全，且路径不会改 .env、不会写现网数据库、也不会应用 249/250 时**，才可以按此前 QH「同意按 a8314a689286 在 macmini 热切换到 Sub2API 0.2.21」继续 prepare / activate。不必再等第二次 activate GO；若路径将改 .env、写库或打 249/250，立即停并报告，不要自行放宽。

## 仍然禁止

- 改 `.env`；写现网数据库；应用或伪造 249/250（包括假写 `schema_migrations`）。
- 为 OAuth #1 重启或重新登录；不要把 #1 当作验收条件。
- 停不相干进程；推 remote；amend `a8314a689286`。
- 打印密钥。盘空间紧张时只回收可丢弃的构建垃圾，不得删现网镜像、现网 volume 或 `backup-Omp0Fv`。

## 成功/失败怎么写

把结果追加进 `NOTES.md`：实际恢复程序改了哪些文件（路径 + 改后 SHA256）、0.2.19/0.2.21 校验结果、实际 image tag/digest、health、StartedAt/RestartCount、`.env`/DB/迁移 249-250 是否未动、新备份路径、演练是否用了现网库副本、是否 activate。若再次硬阻断，停在卡点，不要 activate。
