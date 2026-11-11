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
