# Factory 订阅额度发布计划

日期：2026-11-03。目标分支：`codex/sync/20261028-v0.2.19`。保持应用版本 `0.2.19`，用新的完整源码 SHA、镜像 ID 和 manifest 摘要标识本次构建。本文为执行计划，不能作为上线或验收完成凭据。

## 范围与门槛

- 只接 Factory 订阅额度，复用 `accounts.extra` 和 `quota_windows`；不增加数据库迁移、不接 Analytics/历史账单、不推算绝对 token 总量。
- 使用账号已有 API key 调固定 billing origin；凭证不得进入日志、报告、代码、命令参数或调研文件，不修改 `.env`。
- 默认按管理端请求缓存 5 分钟，手动刷新限频 30 秒，合并并发，设置超时和 429 退避；失败保留旧观测并标记 stale。实例启动不能自动产生 billing 请求或写入额度状态。
- P0 放行必须经本任务 E0 转达；放行前可以实现、验证、构建和预发布验收，不能切换现网流量。文件名、历史操作授权和已构建镜像均不是放行证据。
- 本轮仅 Mac mini。不得改 HK、现有 Factory Claude 路由/凭证、其他工作区或 unrelated workloads。

## 当前只读基线

2026-11-03 检查时：`sub2api-current-app` 为 running/healthy、重启次数 0，镜像 `sha256:b11cdf9fbdb326a5b0cc400b3e6c94f972274647c488714c493d8f2307696a47`。原发布记录见 `LOCAL_DELIVERY_FACTORY_0.2.19.md`。最终执行前重新检查，不把当前读数当持续保证。

宿主 Data 卷约 7.5 GiB 可用。专用 `sub2api-release-20261002` builder 采用 1 CPU、2560 MiB、单构建并行，Go 编译并行 2、内存目标 768 MiB；现有 build cache 约 4.285 GB。构建、Go 全套验证、隔离数据库演练顺序执行，保留至少 3 GiB 宿主余量；发现压力时停止本任务工作负载，不清除既有证据、用户缓存或回滚镜像。

旧资源清单为 1378 件、58,917,928 字节；现限额 1500 件/96 MiB。新构建若 180 件全部改变 hash，合并上界约 1558 件。构建后先计算精确增量；如需提高件数限制，必须记录真实清单/字节容量并保持明确上限及原 96 MiB 总字节限制，禁止静默修剪正在使用的旧资源。

本次精确应用树 production build 后的实际清单为 180 件、6,576,916 字节，其中仅 112 件新增 hash、4,894,174 字节；与既有清单合并为 1490 件、63,812,102 字节。尚未超出原上限，因此不提高 cap。镜像构建后仍需对确切嵌入资源验证。

本轮 Go 验证曾因宿主空间降到 3 GiB 以下暂停。直接把临时可执行文件放在 SSD 的 exFAT/fskit 文件系统会产生 `exec format error`；该失败是环境验证失败，不能记为源码测试失败或通过。为此在 `/Volumes/SSD/factory-usage-build.JfBhb5/compile-apfs.sparseimage` 创建仅供本任务使用、32 GiB 逻辑上限的 APFS 稀疏盘，挂载 `/Volumes/FactoryUsageBuild`（nobrowse）。小型 Go 程序已执行通过。后续 `TMPDIR=/Volumes/FactoryUsageBuild/tmp`，`SUB2API_TEST_GOCACHE=/Volumes/FactoryUsageBuild/gocache`；测试工具仅允许显式绝对路径、已存在目录的 cache override，其余环境仍白名单过滤。该盘不放凭证、生产数据或备份。root 将本轮新安装的 `frontend/node_modules` 完整移动到该盘并在原位留符号链接；又仅转存五个本轮生成、可验证包含当前 checkout 路径的 Go 缓存对象，共约 1.047 GiB，保存在 `retained-task-cache` 供恢复。其余原有缓存、旧临时目录和回滚材料均保留，没有删除。

## 执行顺序

1. 后端和前端各完成契约、异常/缓存/限频测试；root 独立评审并集成到正式 sync 分支。新测试结果绑定本次精确 backend/frontend Git tree，不能沿用上次的通过数量。
2. 顺序运行后端 unit/integration、安全依赖测试、前端 typecheck/lint/test/build，以及发布工具测试。本计划写入前，现有发布工具测试为 76/76；修改工具后需重跑相关用例。
3. 更新 `deploy/local-upgrade/source-validation.json` 为本次新证据，提交后保持工作区干净。执行 `node deploy/local-upgrade/build-local.mjs`，只打 `linux/arm64`；验证完整源码 SHA、OCI labels、image ID、manifest 和 SHA256SUMS。
4. 对确切镜像执行空库 smoke、静态资源连续性和代理 fixture 测试；记录 CPU/内存和稳定入口健康。不得把 fixture 等同现网连接排空。
5. 按 `LOCAL_UPGRADE.md` 对当前应用做受保护灾备，再以相同 manifest 完成隔离恢复演练。完整备份会包含系统既有凭证，因此 root 必须先明确本任务“不落盘 Factory key”与要求的受保护灾备之间的边界；未经处理不能自行导出账号凭证或改变备份语义。
6. 演练使用 internal/no-egress 网络、无宿主端口、独立 DB/Redis/app volumes；验证 299 个真实迁移文件及 checksum 不变、业务/配置/凭证 hash 不变、旧新程序双向读写和重启兼容；清理仅所属演练资源。
7. 用确切成功恢复报告执行 `upgrade-current.mjs prepare MANIFEST BACKUP RESTORE_REPORT`。此命令只准备 loopback `18585` 候选且保留旧路由，但内部会执行 current Codex 和 Terra 各一次短真实请求，不自动重试；应纳入本轮调用预算，不重复已完成调研。
8. 候选验收账号 13：Factory 平台、六个额度窗口、订阅/超额/余额状态、reset/更新时间、真实百分比/unknown/stale、手动限频、列表与管理端组件。Factory key 仅从 admin API 到进程内存，不单独读取数据库提取 key。再执行一次限输出 Factory Claude 端到端推理回归，并核验终止事件和准确 usage 行。
9. 确认 E0 已转达 P0 放行及所有技术门槛后，root 才执行 `upgrade-current.mjs activate MANIFEST`。复查稳定入口 `18480`/兼容 `18080`、原 HTTPS 入口、账号 13 展示、既有模型、后台唯一所有者、`.env` 摘要和恢复身份。没有放行就保持旧流量并交付待切换状态。
10. 保留旧镜像 `b11cdf9f…`、旧私有 Compose/state、备份与 manifest。回滚命令为 `node deploy/local-upgrade/upgrade-current.mjs rollback NEW_MANIFEST`；不恢复旧数据库覆盖新写入，不删除既有回滚点。

## 交付证据

最终写入 `/tmp/factory-usage-release-report-cn.md`：正式分支和远端 SHA、镜像 ID/标签、manifest 摘要、备份/恢复报告、P0 放行状态、候选/生产验收结果、确切回滚命令、已知限制。未执行项明确写为未执行，不把源码测试或预发布检查写成生产完成。

执行中发现的外部门槛：配置的 `fork` 当前为 public，和原规范的 private 前提不符，未经解决不推送。旧生产 `b11cdf9f…` 的账号 13 已因 standard 五小时额度耗尽返回 402 并暂停调度；该事件发生在本次部署之前，不是本次功能回归。继续完成合成与隔离验证，但不清除现网错误、不启用超额、不重复付费调用；真实 Factory Claude 验收待额度恢复及现网门槛满足。
