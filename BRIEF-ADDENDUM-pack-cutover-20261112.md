# BRIEF-ADDENDUM — 打包并升级现网（不写现网库）

时间：2026-11-12 ~09:45 Asia/Taipei  
来源：QH 亲口（P0 1:1，先回「升级现网」，随后明确「打包然后升级现网」）

## 批准范围

同一任务续做（同一 tab `cutover-0.2.21-a8314a`，同一 pane `codex-plan-021-a8314a` / t29），不是新任务。

QH 要求：先打包，再升级现网。此前 a8314a689286 / PR #5 的热切换批准仍有效。本轮**不**放宽「不写现网数据库」：不能把「升级现网」理解成允许对现网库做 POST `/auth/login`、写入 usage 行，或改 last_login_at / last_active_at。必须先改 `prepare`/`activate`，确认整条切流路径不会写现网库，再打包、做新的受保护备份、用现网库副本演练；通过后才 activate。

## 只读复核（2026-11-12 09:44 Asia/Taipei）

- 现网仍是 `sub2api-local:0.2.19-466dc86d2eec` / digest `sha256:ed98069e97165ce50a1286cd7707fa250c8b864e4651ab63cad0d3ce1e5b1655` / revision `466dc86d2eec60c8d56398dcae627a3f1c375127`。`sub2api-current-app` healthy；18480/18080/18583 `/health` 均为 `{"status":"ok"}`。StartedAt 仍是 `2026-11-08T08:53:42.616998344Z`，RestartCount=6。没有 0.2.21 镜像。
- `.env` 未动：mtime `2026-09-24T18:02:14+0800`，605 bytes，0600，SHA256 `63503f4f21908be7b28ba9686c109e20498cb489ef429a9f8277c42d08a0bc14`。
- 现网恢复程序仍是已批准的兼容版：`service-recovery.mjs` SHA256 `644bbcf5ffc36e55c83bc9acb2b3b1d174bf2985ff6f5c2c892488409b05eef6`。本轮不要再改恢复程序，除非只读证明 0.2.21 又无法被接受。
- 工作树 detached HEAD 为本地文档提交 `a100bf009609`（父 `fe58becea575`，批准源 merge 仍是 `a8314a689286` / PR #5），未 push。`release/sub2api_0.2.21_linux_arm64_fe58becea575/` 仍只有 `source.tar.gz` 和 `BUILDING.json`。
- 磁盘仍紧：Data 卷约 15Gi 可用（93%）。不要删现网镜像、volume 或 `backup-Omp0Fv`。host 可用 <3GiB、Docker data 可用 <5GiB，或现网 health 回退，则硬停并写入 NOTES。

## 上轮已定位、本轮要处理的两件事

1. **打包内存**：frontend-builder 第 8/8 步 `cannot allocate memory` / `ResourceExhausted`，docker-buildx 退出码 102。NOTES 记录：镜像内独立 i18n / `vue-tsc -b` 已通过，Vite 在 transforming 阶段失败；`vite-plugin-checker` 又拉起约 1.5GiB 的 `vue-tsc --noEmit`，与 Vite 同时贴近 2560 MiB cgroup。允许为打包做最小构建修复：优先串行完成完整类型检查，避免与 Vite 同阶段重复跑 `vue-tsc`；不要整段跳过类型检查。不要把加内存当作第一手段。改动范围仅限打包所需；不要改应用业务源码、不要改迁移文件。
2. **prepare/activate 写库冲突**：现有 `upgrade-current.mjs` 的 `session()` 会对现网 `/auth/login` 发 POST；`verifyTerra` / `validateTerraUsage` 还要求在现网查出新的 usage 行。auth 的 `touchUserLogin` 会写 last_login_at/last_active_at。必须改掉这条现网写路径，改为只读门禁（health / ledger / 源校验）加上已有的现网库副本演练来证明行为。禁止对现网发会写库的请求来“验证”。若做不到不写现网库，硬停并写入 NOTES，不要 activate。

## 仍禁止

- 自动或手动 apply 迁移 249/250；不要伪造 schema_migrations 行。
- 改现网 `.env` 或写现网数据库。
- 使用或激活 `c5ec507`。
- amend `a8314a689286`；push origin（Wei-Shaw）或 fork，除非 P0 后来说可以。
- 为 OpenAI oauth 账号 #1 重登或重启；不要把它当成验收条件。
- 触发真实恢复、改 plist/dispatcher，或用这次修改当借口重启现网。
- 删除或覆盖 `backup-Omp0Fv`。
- 打印密钥。

## 顺序

1. 先改本工作树（及切流实际会调用的）`prepare`/`activate`，用测试证明它们不会对现网写库。
2. 再按实际干净 HEAD 打包；镜像 tag 用鉴定后实际 HEAD 的 12 位，形如 `sub2api-local:0.2.21-<12-char>`。不要手填 tag。
3. 新建受保护备份（保留 `backup-Omp0Fv`）。
4. 用非空现网库副本演练（299 条、停在 248 的账本）；断言 filename/checksum 集合到 248 不变，三条 post-248 文件保持未应用；证明 0.2.21 能在副本上启动且不打 249/250。空库/新库不是可放行路径。
5. 仅当路径不会改 `.env`、不会写现网库、也不会打 249/250 时，才 prepare/activate。

演练或切流若发现会打迁移、要改库或改 `.env`，硬停并回报。完成后把实际 image tag、health、`.env`/DB/迁移是否未动、prepare/activate 与构建改了什么写入 NOTES。
