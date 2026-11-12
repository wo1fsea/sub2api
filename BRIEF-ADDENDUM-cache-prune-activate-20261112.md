# BRIEF-ADDENDUM-cache-prune-activate-20261112.md

写于 2026-11-12 11:23:29 Asia/Taipei。同一条 a8314a 切流续做，仍用 tab `cutover-0.2.21-a8314a` / pane `codex-plan-021-a8314a`（t29），不要新开 tab，不要 /clear。

## 用户原话

QH 已在 E0 聊天拍板，原话是「清掉过旧的历史前端资源」。按此范围执行：先清理过旧的历史前端缓存，**不要放宽 1800 项 / 96MiB 预算**，然后再对已保留的候选镜像重试 prepare/activate。

## 候选与上次停点

- 不要重新打包，除非只读证明候选镜像已不在。已保留的镜像是 `sub2api-local:0.2.21-121573906e4d`（`sha256:da2f09731adeaf048341b7fd627f14209c8e8a0b322c2b174f0d213c25d8b14e`，revision `121573906e4ddb2c1a7e381e4951f15ea1094b56`）。
- 隔离演练 `rehearsal-nqHIp2` 已通过（mode `hot-cutover-0.2.19-to-0.2.21-schema-248`）。新备份 `backup-aDGPmz` 保留，旧备份 `backup-Omp0Fv` 也保留，都不要删。
- 上次 prepare 卡在合并历史 frontend assets：`Historical frontend cache exceeds its retention budget`。当时原缓存 1712 项、73,610,796 bytes（约 70.2MiB），预算是 1800 项且小于 96MiB。失败发生在写入 cacheAssets 和切换路由之前，随后已 rollback 为 `rolled-back-verified`，route 仍是 current。现网仍是 `0.2.19-466dc86d2eec`。

## 必须怎么做

1. 只删**过旧的历史** frontend assets，给这次合并腾出空间。清理前后都要记录项数和体积，并确认清理后（以及合并后的预期占用）低于现有预算。
2. **不要改预算数字**（仍是 1800 项且小于 96MiB）。
3. **不要为了过关删掉 current 正在用的前端**。必须保留足够回滚到现网 0.2.19 的资源。
4. 然后用已有的只读 prepare/activate 路径，对上述候选镜像重试 prepare，通过后再 activate。
5. prepare 失败就按规定 rollback，不要强行 activate。

## 仍然禁止

- 现网仍按 0.2.19-466dc86d2eec 保护：`.env` 与现网库不动，不打迁移 249/250，不写现网库。
- 不要碰 Magpie 安装（另一条已拍板的旁路线；tab `install-docker` / pane t2b）。不要停、删、改容器 `magpie`、卷 `magpie-config`，也不要改 Tailscale Serve。
- 不要改 Clash，不要推送 origin，不要 amend 已有提交。

## 回报（做完或再阻断都要写进 NOTES）

- 清理前后的缓存项数/体积，是否已低于预算
- prepare/activate 结果（成功则给出实际 image tag、route/状态；失败则 rollback 状态与原因）
- 现网镜像 / 健康 / StartedAt / RestartCount
- `.env` 是否未动，schema 是否仍 299 条、止于 248，249/250 是否仍未应用

做完或硬停后停下等 P0 验收转述。
