# 2026-11-12 — 只读切流与最小构建修复：源码门禁完成，等待打包/副本证明

已读取 BRIEF-ADDENDUM-pack-cutover-20261112.md，同一任务续做。prepare/activate 及失败回滚均已移除 session 登录、authenticated API、quota batch、liveGateway/verifyTerra 真实推理与新增 usage 验证。实际切流仅调用本工作树 `upgrade-current.mjs`；其唯一 HTTP transport 强制无 credentials 的 GET、禁止 redirect，仅允许固定现网/candidate origin 的 `/health`、`/login` 静态页面和 hashed `/assets`。`/login` 的服务端 public settings 注入经源码核对仅 GetMultiple 读取，不调用 auth login。所有三处 psql 查询经同一 single-SELECT + BEGIN READ ONLY + bounded timeout + ROLLBACK 门禁；无手工 DML/DDL。镜像标签/digest、248账本与副本报告提供身份/兼容资格；不再用真实现网推理作为资格。切流和回滚各阶段校验 `.env` hash/mtime/size/mode。

隔离演练仍绑定确切 image/backup/tool hashes 和非空299条248账本；增加启动和重启的三条 migration skip / schema capability 日志证据。跨版本新派生 admin API 默认值仅记录脱敏指纹，持久化 settings/business/configuration 的完全一致断言保留，不把 API 展示形状变化误认为已写库。业务写入测试仍仅在 internal network 的独立数据库副本中执行。

85 项 local-upgrade 测试通过：包括实际 HTTP transport 对登录、推理、POST/body/auth headers 的拒绝（无网络发送），生产源码 AST 检查禁止绕过传输门禁、三处SQL必须只读，以及启动/重启缺失证据拒绝。前端 vue-tsc 类型检查通过。构建修复仅在 `frontend/vite.config.ts` 设置 checker `enableBuild:false`，保留开发 checker、package.json/Dockerfile 中独立完整 `vue-tsc -b && vite build` 的串行顺序；未加内存、未跳过完整类型检查、未改业务后端/SQL。

切前只读核对：仍为原0.2.19 digest/revision、healthy，18480/18080 ok，StartedAt不变/RestartCount=6；`.env` SHA256仍`63503f4f21908be7b28ba9686c109e20498cb489ef429a9f8277c42d08a0bc14`。已部署 recovery SHA256仍`644bbcf5ffc36e55c83bc9acb2b3b1d174bf2985ff6f5c2c892488409b05eef6`，0.2.19/0.2.21纯校验accepted=true，本轮未改该程序。host约15GiB、Docker data约20GiB可用。下一阶段按实际干净HEAD打包；任何host<3GiB、Docker data<5GiB或现网health回退均停止。

---

# 2026-11-12 00:02 +0800 — 续做结果：恢复兼容已完成，打包内存失败，未 activate

依据追加批准继续同一任务，恢复兼容 blocker 已解除；随后按实际干净 HEAD `fe58becea5756f429b33887482d7e6bcf01e134f` 运行 `node deploy/local-upgrade/build-local.mjs`。构建在 frontend-builder 8/8 失败，遵守“失败即停”，未重试或放宽构建资源，也未继续新数据库备份、隔离演练、prepare、activate。0.2.19→0.2.21 的现网副本启动/重启安全证明仍未完成。

## 已完成的现网恢复兼容修改

实际文件 `/Users/clawbotbot/Projects/sub2api-neubrutalism/deploy/local-upgrade/service-recovery.mjs` 仅两处变化：supportedVersions 增加 0.2.21；active manifest 路径正则从 `(13|19)` 扩为 `(13|19|21)`。原 0.2.13/0.2.19 兼容保留，无其他恢复行为变化。改后 SHA256=`644bbcf5ffc36e55c83bc9acb2b3b1d174bf2985ff6f5c2c892488409b05eef6`，本地提交 `00ba0f27d`，未 push。

改前备份 `/Users/clawbotbot/Projects/sub2api-upgrade-private/recovery-021-6YHtqq/service-recovery.mjs`（目录0700/文件0600），SHA256=`37205b5fcbdf773459d083b9547f1884aaafa4c1f9f006e4127eb5521edb3b7d`。改后仅 import 纯校验函数，并从实际文件提取 manifest 正则：0.2.13/0.2.19/0.2.21 均 `accepted=true`、`manifestPathAccepted=true`；0.2.20/0.2.22 仍拒绝。未调用 boot/真实恢复、未改 plist/dispatcher 或 `/Library` 文件；未为 OAuth #1 重启或登录。本工作树同步了这两处校验，81 项升级工具测试全部通过。

## 当前 blocker 与后续边界

构建原始错误摘要：`frontend-builder 8/8 ... cannot allocate memory`；`failed to solve: ResourceExhausted`；docker-buildx exit=102，build-local exit=1。镜像内独立的 i18n 3 tests 和 `vue-tsc -b` 已通过，Vite 在 `transforming...` 阶段失败。构建资源保持原配置（builder 2560 MiB、CPU quota=100000，Vite heap=1664 MiB）。只读进程证据显示 Vite 主进程约901 MiB RSS，同时 `vite-plugin-checker` 又启动 `vue-tsc --noEmit` 约1.5 GiB RSS；cgroup memory.current 接近2684354560，发生持续内存回收。`frontend/vite.config.ts` 的 `checker({ vueTsc: true })` 在生产 build 也开启检查，Dockerfile 在此之前已独立执行 vue-tsc。未修改 frontend/Dockerfile/build-inputs，也未跳过检查、加内存或重跑。后续若获准修复构建，应评估串行完成完整类型检查、避免同阶段重复检查的资源占用；这只是定位建议，本轮没有实施。

另外，只读检查确认现有 `upgrade-current.mjs prepare/activate` 与“不会写现网库”存在独立冲突：`session()` 对现网 `/auth/login` 发 POST；`prepare()` 调用真实 `liveGateway` / `verifyTerra`，后者明确要求 `validateTerraUsage` 查到新持久化 usage row（找不到会报 `Terra usage row was not persisted for this request`）。auth 的 `touchUserLogin` 会写 last_login_at/last_active_at，真实推理还会记录用量/计费。因此即使未来副本迁移演练通过，也不能在当前严格零现网写库约束下直接运行该现网验证路径。本轮未调用这些函数或发送此类现网请求，未将自动业务写入解释为已获豁免。

## 最终实际状态

- **实际现网 image tag**：`sub2api-local:0.2.19-466dc86d2eec`；实际 image ID/digest=`sha256:ed98069e97165ce50a1286cd7707fa250c8b864e4651ab63cad0d3ce1e5b1655`；revision=`466dc86d2eec60c8d56398dcae627a3f1c375127`。
- **0.2.21 候选镜像**：未生成，无实际 tag/digest、无 manifest、未 load。`release/sub2api_0.2.21_linux_arm64_fe58becea575/` 仅保留 `source.tar.gz` 和 `BUILDING.json`（约14 MiB）；不能当作完成的发布包。
- **health**：`sub2api-current-app` healthy；18480/18080 均 `{"status":"ok"}`。StartedAt=`2026-11-08T08:53:42.616998344Z`，RestartCount=6，均未变；未切流或重启 app。
- **.env**：SHA256=`63503f4f21908be7b28ba9686c109e20498cb489ef429a9f8277c42d08a0bc14`，mtime=`2026-09-24T18:02:14+0800`，605 bytes，0600，未变。未输出其中内容。
- **DB/迁移**：本轮仅 READ ONLY/SELECT，未向现网写库、运行迁移或 restore。最终299条、末条`248_group_image_count_billing.sql`，账本指纹仍`6881ca3d0765b3d4376b867c6012863a`；public schema列数1460、指纹仍`259bcb175bb7a2f0487793af6260f79c`；249/250入账数=0，对应MCP表、TTL/12h定价列、cost索引均为0。现网常规业务仍运行，不声称整个活动数据库字节不变。
- **现网 compose/state**：未改。current compose SHA256仍`cb98c8985eb2df8f3aeed7073648a15e92538c1c8240d660015ddb5c10a8e325`；current state仍`4980a4a2e84efa1988dbc0aecbe27a1edda579ab9aef490e7474160a2c9327cc`。
- **备份/演练**：本轮只有上述恢复程序文件备份；新受保护DB/app/Redis备份和现网库副本演练未执行，因为打包失败。旧`backup-Omp0Fv`保留未覆盖/删除。无prepare/activate/rollback。
- **资源/清理**：最终host约16 GiB可用，Docker data约20 GiB可用；未删除或prune镜像、volume、备份。仅停止本轮启动且构建已结束的`sub2api-release-20261002` builder，恢复其切前stopped状态；保留可供后续诊断的构建缓存和失败包目录，没有停不相关进程。

以下为同一任务前序记录，保留用于追溯。

---

# 2026-11-11 续做 — recovery blocker 已解除，后续门禁仍待证明

已读取 BRIEF-ADDENDUM-recovery-0.2.21.md 与追加后的 BRIEF。按 QH 新授权，只读复核实际 plist/dispatcher 路径和现网 0.2.19 identity/health 后，备份并修改实际运行的 `/Users/clawbotbot/Projects/sub2api-neubrutalism/deploy/local-upgrade/service-recovery.mjs`。仅扩大 supportedVersions 和 active manifest 路径正则，增加 0.2.21；保留 0.2.13/0.2.19。未修改 `/Library` 文件、plist 指向或其他恢复行为，未调用 boot/真实恢复，未重启应用。

- 改前受保护备份：`/Users/clawbotbot/Projects/sub2api-upgrade-private/recovery-021-6YHtqq/service-recovery.mjs`，目录 0700 / 文件 0600；SHA256=`37205b5fcbdf773459d083b9547f1884aaafa4c1f9f006e4127eb5521edb3b7d`。
- 实际现网文件改后 SHA256=`644bbcf5ffc36e55c83bc9acb2b3b1d174bf2985ff6f5c2c892488409b05eef6`。本工作树相同文件同步两处校验改动，供后续包内工具一致使用；真实部署修改首先完成并验证。
- 纯函数 `releasePin` / `assertVersion` 与从实际文件提取的 manifest 路径正则：0.2.13、0.2.19、0.2.21 均 accepted=true；0.2.20/0.2.22 仍拒绝。未调用恢复 main。
- 本轮起始现网仍是 `sub2api-local:0.2.19-466dc86d2eec` / `sha256:ed98069e97165ce50a1286cd7707fa250c8b864e4651ab63cad0d3ce1e5b1655`，healthy；18480/18080 ok；StartedAt=`2026-11-08T08:53:42.616998344Z`，RestartCount=6；`.env` 指纹、mtime、size、mode 均与前轮一致。host 可用约16 GiB / Docker data约20 GiB，未清理旧镜像、volume、备份。

后端/frontend/migrations 应用树未变化，沿用本任务上一阶段实际测试证据；恢复校验通过不代表运行时 248 演练通过。接续阶段需按实际干净 HEAD 打包、新受保护备份、现网非空库副本演练；prepare/activate 另须满足“不写现网数据库”的硬约束。旧阶段记录保留如下。

---

# 2026-11-11 — 0.2.21 / a8314a689286 热切换鉴定：BLOCKED，未 activate

本轮依据本目录 BRIEF.md 执行。鉴定应用源码为 merge commit `a8314a689286dfac8d26b017e2b853d8335c19bb`，未 amend、未推送任何 remote。下面的本地工具改动不代表已完成打包或运行时资格验证。

## 决定与实际 blocker

停止在源码/工具鉴定阶段；未构建候选镜像，未新建备份，未运行隔离演练、prepare、activate 或 rollback。没有可报告的 0.2.21 image tag/digest；不能把 merge SHA 或本地鉴定提交拼成一个未实际生成的镜像 tag。

实际安装的 `/Library/LaunchDaemons/net.clawbotbot.sub2api-recovery.plist` 每 60 秒执行 `/Library/Application Support/Sub2API Recovery/launchd-recovery.mjs`。这个 root-owned dispatcher 固定调用 `/Users/clawbotbot/Projects/sub2api-neubrutalism/deploy/local-upgrade/service-recovery.mjs`，并不使用本工作树。已核对该现网程序：

- `supportedVersions` 仅允许 0.2.13 / 0.2.19；`releasePin` 和 `assertVersion` 拒绝 0.2.21。
- `boot` 在操作服务之前要求 active manifest 路径匹配 `sub2api_0.2.(13|19)_linux_arm64_<sha>/manifest.json`，因此真实 0.2.21 manifest 也会被路径校验拒绝。
- 仅 import 其纯校验函数，用合成 manifest/metadata 验证：0.2.19 accepted=true；0.2.21 accepted=false，错误为 `Unsupported release version`。未调用 boot/status/恢复动作，未改其文件或 launchd。
- dispatcher SHA256：`4625d6e19356df8a4d636dfb5ce48b7fc1bf6c61c43af2512413f9c3a2f203dd`；实际 recovery 程序 SHA256：`37205b5fcbdf773459d083b9547f1884aaafa4c1f9f006e4127eb5521edb3b7d`。

因此，把新 image/manifest 写入 upgrade state 后，已安装的恢复程序将无法接受新版本。这不证明 248 兼容层一定失败，但证明目前尚无完整、可放行的安全切换/恢复路径。BRIEF 只允许改现网 image/compose/upgrade state 和本工作树鉴定/升级脚本；修复另一工作树内实际部署的恢复程序超出该边界。未通过伪造版本、路径或账本规避。后续需 P0 先明确解决该现网恢复兼容范围，再继续实际打包、受保护新备份及现网库副本演练；本轮不自行扩大权限。

## 248 路径已证明与尚未证明的部分

只读核对现网 `schema_migrations`：299 条，最后 `248_group_image_count_billing.sql`，与本 HEAD 的全部已应用文件名/checksum 逐项一致。目标源码共 302 个 SQL，唯独下面三个未入账，不能因它们嵌入镜像而要求应用：

- `249_add_usage_logs_api_key_cost_index_notx.sql`
- `249_mcp_oauth.sql`
- `250_openai_cache_write_ttl.sql`

现网 MCP OAuth 表数=0，post-248 TTL/12h 定价列数=0，`idx_usage_logs_api_key_created_cost` 索引数=0。账本 MD5（按 filename 排序拼接 filename:checksum）为 `6881ca3d0765b3d4376b867c6012863a`。public schema 列数=1460，列元数据指纹 `259bcb175bb7a2f0487793af6260f79c`。Atlas 账本原本有 1 条、version=`237_add_minimax_platform`；本轮未改动。

本地新增 mode `hot-cutover-0.2.19-to-0.2.21-schema-248`：复用零变化演练要求，额外强制非空且完整的 299 条 248 账本、精确 source checksum、三条 deferred 文件始终未应用，以及启动/重启前后对应表/列/索引持续缺席。没有新增会应用 249/250 的 mode。prepare/activate 增加只读现网 ledger/source/object 门禁，不能接受同版本旧报告、空库报告或缺失证据。隔离脚本加入真实用量/渠道读取与 MCP 缺表受控 503 检查。

这些是已通过单元测试的本地工具改动，**尚未在现网数据库副本上执行**。没有“0.2.21 进程实际启动后跳过三条迁移”的日志/报告，也没有隔离演练的运行时兼容 PASS；不据此放行。应用源码、SQL 文件、VERSION、build-inputs 均未改变。

## 实际鉴定检查

- 后端 `node deploy/local-upgrade/test-backend.mjs unit`：Go 1.27.4，61 包、27,105 tests PASS，42 skipped，0 failures，未跑 race。包含 page-context、call_id、迁移/248 schema 兼容及 Factory 回归。runner 不继承现网测试凭据。报告 `frontend/tmp/backend-tests/run-RDYxYn/report.json`，仅本地 ignored artifact。
- 升级工具 `node --test deploy/local-upgrade/*.test.mjs`：81/81 PASS，包含空账本、迁移新增/缺失/checksum 变化、post-248 对象及不完整报告的拒绝检查。
- 前端使用 pnpm 9.15.9 frozen-lockfile 安装（ignore-scripts），vue-tsc 类型检查 PASS；localeKeyCompleteness、UsageView、MCPView、KeysView 共 4 文件/52 tests PASS。未声称前端全套测试或 ARM64 image build 完成。
- `source-validation.json` 已更新为上述实际源码树与证据，明确标记生产 blocker、未演练、未部署，未沿用旧 0.2.19 鉴定结果。

## 现网实际状态与不变性

切前重新 inspect，停止后再次核对（2026-11-11 23:38 +0800 附近）：

- 实际 image tag：`sub2api-local:0.2.19-466dc86d2eec`；运行配置使用 digest pin。
- 实际 image ID/digest：`sha256:ed98069e97165ce50a1286cd7707fa250c8b864e4651ab63cad0d3ce1e5b1655`。
- 实际 revision：`466dc86d2eec60c8d56398dcae627a3f1c375127`。
- `sub2api-current-app` = healthy；18480 与 18080 `/health` 均为 `{"status":"ok"}`。StartedAt 仍为 `2026-11-08T08:53:42.616998344Z`，RestartCount 仍为 6；本轮未重启 app，也未处理 OAuth #1。
- `.env` 未读出内容、未改写：mtime=`2026-09-24T18:02:14+0800`，605 bytes，0600；SHA256=`63503f4f21908be7b28ba9686c109e20498cb489ef429a9f8277c42d08a0bc14`。
- DB：本轮仅执行只读 SELECT/READ ONLY 检查，未执行数据/DDL 写入、迁移、账本插入、restore 或升级启动。299 条迁移和上述 schema 指纹保持一致，249/250 未应用。这里的“DB 未动”指本轮未操作写库；现网仍承接正常业务，不声称整个活动数据库逐字节静止。
- 现网 compose/state 未改。`current-0.2.13/compose-private.json` SHA256=`cb98c8985eb2df8f3aeed7073648a15e92538c1c8240d660015ddb5c10a8e325`，`state.json`=`4980a4a2e84efa1988dbc0aecbe27a1edda579ab9aef490e7474160a2c9327cc`；`upgrade-0.2.19-466dc86d2eec/compose-private.json`=`fb241b8221af86cecdbd3c24d37177806729a5e5a8855b889a8cb179368eca23`，`state.json`=`4a8dc232101975055fec2d3e92fdd39c42994e4fac4b1fe134101445eb16b7e0`。
- 新备份路径/演练报告：无（在鉴定即停）。原 `/Users/clawbotbot/Projects/sub2api-upgrade-private/backup-Omp0Fv` 保留，未覆盖/删除；未删除任何现网 image/volume。
- 磁盘：起始约 14 GiB 可用，停止时约 16 GiB；Docker data 盘约 20 GiB 可用。未 prune 或清除任何数据；Docker images=12、containers=7、volumes=7、build cache=0。测试报告有界，不采集现网请求日志或 secret snapshot。

---

# Factory upstream implementation

## M0 — evidence and implementation plan (2026-11-02)

Scope: `codex/feat/factory-upstream`, fork `wo1fsea/sub2api`, base `9f3e93c1c`. No production Docker/Compose, production data, remote host changes, or origin pushes. Planning and acceptance are coordinated by `codex-plan` (`hc t4`); implementation/build/review are delegated through local `hc` terminals.

### Protocol evidence

- https://github.com/yetone/magpie/blob/main/internal/provider/factory_key.go and `factory.go`: API keys are `Bearer fk-…`, never refreshed; GET `/api/cli/whoami` with `X-Factory-Whoami-Extended: true`. Key accounts normally have no organization header. WorkOS `orgId` differs from Factory `activeOrganizationId`.
- https://github.com/magpie-community/plugins/tree/48d0cecaf808ddfc001a945c58e955ced99b2d29/packages/factory (read-only reference checkout `/tmp/sub2api-factory-reference-20261102`). README, `index.mjs`, request tests and model fixtures establish Droid inference routes: `/api/llm/a/v1/messages`, `/api/llm/o/v1/responses`, `/api/llm/o/v1/chat/completions`; Gemini has a distinct `/api/llm/g/v1/generate` body.
- Thus the direct inference adapter can use these observed Droid routes; it does not need to invent a Sessions REST lifecycle or forward all models to generic `/v1/chat/completions`. This is community protocol evidence, not a guarantee from Factory or a live subscription test.
- Headers include Factory client/version, provider, routing source and generated session/message identifiers. OpenAI provider uses the plugin's observed OpenAI-Platform header; Anthropic uses placeholder X-Api-Key beside bearer auth. Droid preamble is required. Preserve caller content; do not port the plugin's broad content rewriting or refusal-evasion behavior.

### Architecture and scope

1. Register `factory` in domain/service platform constants and the central platform catalog. Use the existing OpenAI gateway family solely for inbound routing, protocol conversion, streaming, scheduling, error policy and billing; Factory remains a distinct account platform with a dedicated outbound adapter.
2. Add a focused `internal/pkg/factory` protocol module and service integration. The module owns official regional hosts, strict credential/model validation, fixed endpoint selection, required headers, minimal idempotent Droid preamble, and bounded whoami decoding. Gateway builders call it after protocol conversion/model mapping and before sending. Never send the Factory key to generic/vendor fallback endpoints.
3. Existing admin account API remains unchanged: `platform: factory`, `type: apikey`, `credentials.api_key` (fk-), `credentials.region` (`us` default or `eu`), optional `credentials.factory_org_id` (Factory active organization only), and existing `credentials.model_mapping`. Store in existing JSONB; no new table/column or dependency is expected. UI omits a blank key on edit; Factory update validation explicitly handles blank inputs. The generic merger preserves only omitted secret fields, not explicit empty/null values. Reject OAuth/cookie and unsupported endpoint overrides for Factory.
4. Region selects `https://api.factory.ai` or `https://api.eu.factory.ai`. No arbitrary credential-bearing base URL, automatic redirect or untrusted whoami host following. Whoami connection test authenticates and reports region/org metadata without silently claiming inference success; mismatch or enterprise host must be actionable. Default key requests omit org header; only explicit Factory org sends it. WorkOS device login/refresh and on-prem hosts are deferred, explicitly documented and not shown as supported auth modes.
5. Models: versioned finite registry derived from cited plugin, covering supported non-Fast Anthropic/Responses/Chat entries. Public canonical names `factory/<upstream-id>`; mapping resolves to exact native ID and authoritative protocol/provider. Native IDs may be accepted as explicit mappings/aliases if validated. Unknown IDs fail locally, never protocol-guess. Exclude Gemini until its generate adapter exists, auto, gated high-cost opt-in/Fast variants. Account availability remains entitlement-dependent. Factory group defaults expose Factory names; composite uses explicit `target_platform=factory` routes to avoid name collisions. Reuse existing allowlists/model mapping and pricing machinery, do not treat Factory credit multipliers as USD prices.
6. Admin UI: Factory selector/icon/name, API key-only create/edit, region selector, optional Factory org with help, capability limitations and explicit mapping examples. Hide generic base URLs/protocol modes/OAuth controls for Factory. Keep catalog synchronized using repository generator test; zh/en locale parity.

### Parallel implementation and gates

- `dsh-impl-backend`: backend protocol module, registry/admin validation, gateway integration, auth test, model/group/composite behavior, bounded mocks/security regressions. Own backend and generated `frontend/src/constants/platformCatalog.builtin.json` only.
- `dsh-impl-ui`: frontend create/edit and display/types/i18n/tests, excluding generated catalog. Own frontend except catalog.
- `dsh-build`: install existing locked frontend dependencies if needed, run focused and wider unit/type/build checks; no production integration/containers. Report baseline vs new failures.
- Independent Codex review (GPT family, high/non-fast, `--yolo --no-daemon`) of DeepSeek implementation; separate acceptance execution via hc. Implementers fix findings, review verifies, plan reconciles and commits/pushes only accepted in-scope changes to fork.

Required verification: route/header/body correctness for all three protocols; streaming and nonstream response/tool/usage preservation through real gateway builders; credential update/redaction; EU/org behavior; no secret leakage/redirects/SSRF/fallback; invalid models and auth modes; group/composite reachability; UI create/edit roundtrip and frontend typecheck/build. Mocks are default. Live inference is not an acceptance claim unless explicitly run and evidenced.

Risks: private Droid protocol/version drift, entitlement/model changes, upstream prompt/client restrictions, incomplete client-specific compatibility, account credit usage differs from USD pricing, WorkOS refresh concurrency is intentionally out of scope. Fail safely on unsupported cases; document limitations.

### Upgrade recommendation

Build/test a separately tagged fork image, then stage with isolated database/Redis and test credentials. Compare the full fork baseline migration chain with production 0.2.19 before any migration; this feature itself needs no migration but baseline 242 removed platform constraints. Back up DB and rehearse rollback before a separately approved deployment. Never roll an old binary onto active Factory accounts without disabling/removing Factory routing first. No deployment is authorized here.

M0 outcome: plan established from repository and reference source. Next: launch local dsh implementation lanes, then build/review/accept. Current setup issue: Minimal is a DSH agent preset under `tui`, not a profile named `Minimal`; use a task-local overlay selecting Minimal, deepseek-v4-flash, reasoning max without changing global defaults.

## M1 — implementation dispatched

Local hc lanes are `t5 dsh-impl-backend`, `t6 dsh-impl-ui`, `t7 dsh-build`, parent `t4`. Both implementation terminals visibly selected deepseek-v4-flash / Max / minimal / Full access using `/tmp/sub2api-factory-dsh-overlay.yml`. Backend owns backend plus generated catalog, UI owns remaining frontend, build owns dependency preparation and verification. No helper may deploy, push, switch branches or start additional agents.

Backend confirmed the contract: authoritative finite model/protocol registry, late outbound auth/header enforcement, redirects disabled through a scoped transport context, whoami auth-only probe, rejected arbitrary endpoint/protocol/auth overrides, no unsupported-model fallback. UI has been notified that Factory's multi-protocol registry does not authorize generic `/models` synchronization or endpoint-edit controls. Next: receive implementations, build and independently review them. No protocol blocker at this checkpoint.

Build setup checkpoint: t7 reports frozen frontend install with pnpm 9.15.9 and dev dependencies enabled (host pnpm 12.14 is incompatible with repository overrides). Lock hash stayed unchanged. Go toolchain auto selects cached Go 1.27.3, matching actual go.mod; module download changed neither go.mod nor go.sum. Node 26 is default, Node 22 is available; CI targets Node 20, so distinguish local from CI validation. `golangci-lint`, `staticcheck`, `gotestsum` are absent; tests/build remain available. Baseline verification is running.

Independent reviewer `t8 codex-review` launched with GPT-6 Astra/high/default tier, `--yolo --no-daemon`, read-only across DeepSeek implementation. Initial assignment is protocol/design integration review; final diff review follows implementation completion.

Initial review correction: generic single-account updates replace non-secret fields and preserve only omitted secrets; bulk updates instead JSONB-merge and bypass single-account validation. Implementers have been instructed to define/test Factory blank-key, region/org clearing and mapping semantics, validate effective bulk target credentials before writes, and give Factory's registry precedence over generic protocol rules. This is pre-implementation review, not final acceptance. Baseline frontend typecheck passed and existing frontend suite reported 384 files / 3070 tests passed; backend baseline is still running.

Baseline complete: t7 reports frontend typecheck, lint and all 3070 tests passing; `go test -tags=unit ./...` passed across backend packages in 4m52s at base `9f3e93c1c` before feature files landed. No dependency lock/module changes. Initial reviewer report `/tmp/factory-review-report.md` identifies 10 integration traps; instructions sent to implementers cover late Fast-intent rejection, backend model-sync entry guard, request preservation through actual gateway paths, Factory-secret error redaction, unsupported endpoints, and native pricing/model ownership. Next: implementation slices and tests, then final review. Operator guide delegated to t7 as `docs/FACTORY_UPSTREAM.md`.

Implementation recovery: DSH shells lacked `apply_patch` on PATH; provided the parent session's absolute tool path. Backend's oversized first patch then stalled in its shell without files; t4 interrupted only t5, which resumed with bounded smaller patches and confirmed `backend/internal/pkg/factory/registry.go` created. UI's `frontend/src/components/account/factory.ts` also landed. No production or global configuration changed. Next: complete gateway/admin/UI integrations and run feature checks.

Parallel test ownership: after baseline/docs completion, t7 additionally owns only `backend/internal/service/factory_acceptance_test.go` and optional `backend/internal/handler/dto/account_mapper_factory_test.go` for independent gateway/admin acceptance coverage. t5 retains production backend and other tests. This avoids serializing all integration tests behind the production implementation; t7 reports production failures to t5 instead of editing its files. The operator guide draft is gitignored by repository `docs/*`; final delivery will explicitly track only `docs/FACTORY_UPSTREAM.md`.

Shell blocker resolved by reproduction: earlier size/heredoc diagnosis was incomplete. DSH's persistent Bash uses `eval` wrapped in ANSI-C quoting; macOS Bash 3.2 history expansion sees literal `!` in Go `!ok` or Vue `<!--`, raises `event not found`, and skips DSH's completion marker. A separate interactive-shell reproduction failed before `set +H` and passed immediately afterward. All DSH lanes instructed to run `set +H` as a separate call after shell resets and escape literal exclamation marks in JS patch arguments when needed. Only task shells were changed, no global harness or production settings.

## M2 — implemented paths and active regression gate

M-live-test authorized: user approved Factory Google-account API-key validation on this local fork after implementation, consisting of whoami and one small inference; Bot obtains the key, stored only in a restricted local temporary file, never git/NOTES. Production compose/.env/services remain out of scope; WorkOS login integration remains deferred.

M-live-test: Bot reports direct whoami PASS on US and EU hosts, and direct US Chat inference PASS using deepseek-v4.1-flash without an org header (HTTP 200; prompt 50/completion 16). Key delivered via restricted local file, never copied into this record. These are Bot's direct-HTTP results, not yet fork-adapter acceptance. Actual whoami reports `inferenceRegion: global|eu`, `isEnterprise: false`, and an official `prem.factory.ai` hint even for this non-enterprise account. Parser/enterprise detection must reflect these observed fields; do not reject every nonempty prem hint or follow arbitrary hosts. User additionally authorized comparing with/without explicit Factory org on the local fork.

UI t6 reports completed create/edit slice: typecheck, targeted lint, 169 tests across 8 files, vue-tsc build and Vite production build passed. Blank API key is omitted; Factory's partial-update merger preserves omitted fields, so explicit `factory_org_id: ""` and `model_mapping: {}` clear those values. UI now sends these deliberately. Backend registry/profile, credentials, three outbound adapters, whoami auth probe and unsupported-operation guards are implemented, with remaining review fixes and fixtures in progress.

t7 actual gateway matrix reached 14/16 passing; failing cases prove Fast intent drops across Messages-to-Responses and Responses-to-Messages conversions, requiring original-request guards before conversion. Other passing coverage includes native/cross protocol routing, tools, streaming/usage, EU/org, hostile credentials and model-sync rejection. No live inference claim. t8 also identified allowlist fallback, raw beta header casing, empty whoami, normalized mapping-key collisions, and raw error/ops secret exposure; these are fix-before-acceptance findings, not waived limitations.

t6 has finished UI and additionally owns only `backend/internal/service/factory_admin_test.go` for actual admin create/update/bulk regressions, including unchanged non-Factory region behavior. t7 owns gateway acceptance tests and final frontend checks. t5 owns production fixes, package tests, group/catalog fixtures and generated catalog. t8 remains independent reviewer. Next: all targeted checks green, final backend/frontend review and separate acceptance, then commit/push to fork. No new dependencies or DB migrations introduced so far.

## M3 — local fork live acceptance PASS

Verified t7 sanitized log `/tmp/factory-build-live-smoke.log`: `TestFactoryLiveSmoke` passed in 2.49s. Local fork AccountTestService authenticated with whoami both without and with explicit Factory org; both returned auth-only success. Exactly one inference ran through OpenAIGatewayService.ForwardAsChatCompletions and a real net/http upstream transport: `factory/deepseek-v4.1-flash`, max_tokens 32, reasoning none, HTTP 200, input_tokens 23/output_tokens 2. No retries or other models. This used in-memory service state, no listener/DB/Redis/container/migration/production changes. The mode-0600 test key file was deleted after the successful run; no key is recorded in source/docs/logs. The Factory-side test credential itself was not revoked by this task.

Actual whoami compatibility now parses `inferenceRegion` (`global` means US, `eu` means EU), checks legacy-region contradictions, recognizes non-enterprise official `https://prem.factory.ai` hints without following them, and rejects enterprise/custom routing. Inference stays on fixed official US/EU hosts.

Admin regression suite passed after missing-target-before-write fix. UI quota persistence and hidden unsupported probe/rate-sync controls passed targeted regressions (130 tests), typecheck/lint/build. Full frontend before these fixes was 386 files/3075 passing. Remaining gate at this checkpoint: Chat SSE error-frame secret redaction, generated catalog/fixtures, final backend suite and independent review. No extra live inference is required.

## M4 — final review, build and independent acceptance PASS

All previously listed blockers are closed, including Chat SSE redaction, normalized alias collisions, hidden form-state leakage, actual model catalog parity and unrelated-platform bulk-update compatibility. The last production change narrowed Factory's missing-target bulk guard so existing non-Factory behavior remains unchanged; it was separately rereviewed before final verification.

t8 independent GPT-family source review signed off with no blocking findings at source fingerprint `f076606483a375f04fddc9735c1c80e38ea725b346ff3cf9fc53be062ba10213`. t14 independent acceptance PASS verified that source checkpoint and the following evidence:

- Frozen backend `go test -tags=unit ./...`: exit 0, 59 packages OK / 52 without test files; service package 231.943s. No failing packages.
- Backend `go build -buildvcs=false -o /tmp/factory-build-server ./cmd/server`: exit 0 in 13s; local macOS arm64 artifact. This verifies compilation, not release packaging/version metadata.
- 25 independent Factory mock acceptance cases passed, including real native/composite account selection, composite alias through actual Forward then RecordUsage with native model pricing, GetAvailableModels, all three outbound protocols, streaming/tools/usage, unsupported-operation rejection and error-secret handling. Additional Factory admin (13), package (14), service unit (2), DTO (1) checks passed. Default live test skips without a key.
- Frontend full suite passed 386 files / 3075 tests before the last focused fixes; post-fix 8-file suite passed 172 tests. Final typecheck, lint, vue-tsc and Vite production build passed. Actual generated platform catalog parity passed. Local Node 26 differs from CI Node 20; Go 1.27.3 and pnpm 9.15.9 were used. golangci-lint/staticcheck were not installed or run.
- Authorized fork live diagnostic remains exactly two successful auth-only probes and one successful US DeepSeek Chat inference (23 input / 2 output tokens); no claim that all models/protocols/regions were live-tested. Temporary key file is absent.

No new dependencies, lockfile changes, schema/database migrations, deployment edits or production service/data changes. WorkOS refresh, Gemini, Fast/auto, arbitrary/enterprise hosts and generic model discovery remain explicitly unsupported. Upgrade recommendation remains a separately tagged fork image and isolated DB/Redis staging, with deployment requiring a later explicit instruction.

Delivery preflight: current feature branch and fork URL verified, remote feature branch absent, no conflict or force-push needed. Include this NOTES record and the exact ignored operator guide `docs/FACTORY_UPSTREAM.md`; exclude local logs/reports/binaries/keys. Next: commit accepted scope and push only `fork/codex/feat/factory-upstream`, verify remote HEAD and clean worktree. No deployment is part of delivery.

## M5 — production rollout authorized, original release line restored

Feature delivery completed at `b51bdd1e87419b4ef204e87d937618d50a8ab919`, pushed to fork feature branch and remote-equal with clean worktree. On 2026-11-02 the user explicitly authorized production rollout, Factory admin onboarding and Pi model registration/testing, conditional on protected volume+secret backup, isolated restore rehearsal, digest-pinned image, unchanged .env/loopback+Tailscale entry and immediate prior-0.2.19 rollback on regressions. New Factory key remains unread until onboarding, then memory-only with immediate source-file secure deletion; never written in this record.

The user's initial `develop` wording was revoked at 23:02. No develop push/build/deployment occurred. Established production release line is `fork/codex/sync/20261028-v0.2.19`, proven by LOCAL_DELIVERY_0.2.19 Branch, UPSTREAM_SYNC_0.2.19 Target branch and previous actual delivery pushes. Local merge `8a8a181a842b7f96ee87a80c0e039d9616f5722e` has parents `9f3e93c1c` and feature `b51bdd1e8`. The helper directory retains its name `sub2api-factory-develop` but now checks out the formal sync branch; local develop is retained, remote develop absent, dev/main untouched. The original clean sync worktree is detached at9f3. No force/reset/deletion used. Later release-source SHA and documentation HEAD must be recorded separately.

Current rollback target independently verified: image `sha256:5a41a1ae1a94546096b9061b6e5b75ecb63ed9bda8c487c0fafbefcda36feb81`, version0.2.19, source `2da76924e7cf050e2d9c6b98eed9b992db0d9756`, current-app healthy, loopback18583 behind18480/18080, Tailscale443 points18480. .env integrity baseline privately recorded; actual PGDATA is `/var/lib/postgresql/data`. All299 deployed migrations match feature source. Same-version rollout adds no migration; rollback must retain current DB data, not restore an old database snapshot.

Baseline existing clients: Codex/Pi client keys retain group10 and identical30-model catalogs; Terra and DeepSeek gateway small calls passed with usage attribution; macmini and ppc Pi deepseek-v4-flash with no extensions completed successfully. Existing catalogs contain no Claude; mapped Claude account12 is unbound and the separate Claude client points8045, so no existing Sub2API Claude baseline is claimed or silently configured. Factory Claude validation remains distinct. t9 weekly review is not modified/interrupted.

Parallel hc lanes: t15 sole release/deployment mutator, t16 fleet baseline/config/probes, t17 independent cross-family ops review, t18 independent acceptance/gateway regression. P0 tools being corrected: explicit0.2.19-to0.2.19 zero-change restore checks; mandatory exact successful restore report; raw secret/config backup and actual PGDATA evidence; rollback restores old local identity/state/route without depending on broken new candidate or shared upstream inference. Codegate remains held until final reviewed tests. Build before final fresh backup; prepare/activate enforce30-minute backup freshness. Build budget: host peak350MB, Docker incremental3GiB; stop at host free<3GiB, Dockerdata free<5GiB, cache>2.5GiB or online health regression. Rehearsal-only VM budget1.5GiB. No pruning or deletion of old rollback materials.

Pi scope: ppc/macmini/MBA backed-up models[] additions with exact IDs aligned to existing overrides and unchanged credentials/providers; WPC ownerW0 later authorized only appending Factory Claude to sub2api.models[], timestamp backup, no CodeMaker/DS/override/other-provider changes or DS test. Each Factory Claude model must be tested once through Pi with no extensions after account readiness. Exact named pi-sub2api-models rule was not found after node/local searches; explicit current user constraints and existing Pi fleet documentation govern the fallback. MBA currently unreachable after bounded checks; ALIENWARE deferred/offline. No node configurations changed at this checkpoint.

## M6 — production package and rollback point (before cutover)

Formal release source is `d784fb507d192ed6c203d0291be03b1abe600480`, normally pushed and remote-equal on `fork/codex/sync/20261028-v0.2.19`; dev/main unchanged and remote develop absent. It includes the feature merge, reviewed P0 ops fixes and real source qualification. Final P0 patch SHA `b9a30363ec5588a2205ab6ccd3f685d195145f282e26b162a9803594d779a15f`:74 ops tests passed; independent review also validated all299 actual migration filenames/checksums including10 letter-suffix names. Application trees match the accepted feature; current source unit/integration/audit qualification is recorded in source-validation.json, not relabeled old evidence.

Candidate image: `sha256:b11cdf9fbdb326a5b0cc400b3e6c94f972274647c488714c493d8f2307696a47` (`sub2api-local:0.2.19-d784fb507d19`, Linux ARM64). Manifest: `/Users/clawbotbot/Projects/sub2api-factory-develop/release/sub2api_0.2.19_linux_arm64_d784fb507d19/manifest.json`, SHA256 `b586b8ea8298ff6abf1ab9dd2982d23fc373799a733daccb740120595e77b56d`. Bundle SHA256 `6e41bed32bef02c2db75ca6cfd72de6cf1a758ffc5c1ab6ca29aea86e6867932`. Reported exact-image smoke15 checks, old/new180-asset continuity and proxy14 checks passed. This is package readiness, not cutover approval; final fresh backup and same-version isolated rehearsal are still required.

Concrete emergency rollback command after preparation/activation of this candidate:

```sh
node /Users/clawbotbot/Projects/sub2api-factory-develop/deploy/local-upgrade/upgrade-current.mjs rollback /Users/clawbotbot/Projects/sub2api-factory-develop/release/sub2api_0.2.19_linux_arm64_d784fb507d19/manifest.json
```

This restores retained prior0.2.19 image `sha256:5a41a1ae1a94546096b9061b6e5b75ecb63ed9bda8c487c0fafbefcda36feb81` with saved prior compose/state under the release-operation lock. It verifies local prior identity/health, restores persistent state and stable route before optional authentication/upstream postchecks; upstream failure is recorded unverified and does not prevent actual restoration. It does not restore PostgreSQL/Redis or discard newly recorded usage. Any existing-client/model/catalog/Pi regression after cutover triggers this rollback immediately, then reporting. Background owner remains singular, .env bytes and other Tailscale services remain unchanged. Before cutover, verify exact backup/rehearsal identities and retained prior artifacts; command is not an instruction to execute early.

The temporary new Factory credential remains unread pending post-cutover acceptance. D uses an isolated temporary probe group/client key through supported admin APIs before joining ALLINONE10; all namespaced mappings prevent existing-model routing changes. The temporary upstream key is consumed in one process and immediately overwritten/fsynced/unlinked, never copied or printed. No Factory onboarding or Pi mutations have occurred at this checkpoint.

## M7 — production, Factory account and Pi namespace repair completed

Production activated successfully at2026-11-02T16:07:05.512Z: image/source remain `b11cdf9f...696a47` / `d784fb507d192ed6c203d0291be03b1abe600480`. Reviewed ops-tool commit is `e7e084a2212aca8996c5fc21a32fd1ba48090859`; later delivery commits are documentation only. Protected backup `/Users/clawbotbot/Projects/sub2api-upgrade-private/backup-qndUzX` and successful isolated rehearsal `/Users/clawbotbot/Projects/sub2api-upgrade-private/rehearsal-aq4sBU/rehearsal-report.json` bind this exact image and backup. All299 migrations and persistent business/settings state stayed unchanged; only the expected derived Factory default quota nulls were added. Prior5a41 image and the concrete M6 rollback command remain retained. App healthy, one background owner, current route, .env unchanged, loopback/Serve unchanged, launchd boot-status accepted the new image. Existing Terra/DS gateway and macmini/ppc Pi DS checks passed, with original client models intact. No production-image rollback was triggered.

Factory account13 `sub2api-live` is active/schedulable, concurrency1, group10 ALLINONE,34 exact `factory/<native>` mappings. Existing client keys7/9 remain in group10 and see64 models: their original30 plus34Factory. Initial isolated Claude and DS calls produced usage219103/219105 on account13; DS response name `accounts/fireworks/models/deepseek-v4p1-flash` caused an over-strict onboarding comparison to stop/disable the new account despite successful usage. The user explicitly accepted this Factory/Fireworks alias; raw response/mismatch and non-exact tiny-text result remain recorded, without an independent weights-equivalence claim. Stored credentials resumed account13 without rereading the consumed key. The ordinary client-key Claude call subsequently passed and usage219273 attributes to account13/key9/group10/native claude-sonnet-4-6. Temporary probe group12/key22 were soft-deleted and unbound. The original Factory key file was overwritten/fsynced/unlinked immediately after one-process consumption; no credential copies or independent provider were created.

E registration initially exposed a bug in our own `pi-fleet-model-discovery`0.2.0: both binding and inventory/cache validation rejected `/` in `factory/...`. On user emergency instruction, macmini/ppc/wpc were timestamp-backed-up and Factory entries removed to restore their launchable configurations. The user canceled the proposed independent-provider workaround and authorized fixing the original extension. No `sub2api-factory` provider was created. Version0.2.1 now uses one bounded namespaced-ID validator across binding/inventory/cache/excluded reports, preserves provider-ID rules and non-chat classification, and retains all existing overrides/auth. Source commit in private `wo1fsea/pi-fleet`: `2aed34382cf139139b4cf7ffe96c65ae64eeded1`; Windows installer follow-up `751f65153029676b0617d493db78fd654aa3f88f`. Seven-file release manifest SHA256 `27246db94ed31f35c538d772ed441085b81398ff7e991a0b7add6f0590a22ea5`. Accepted changes were normally pushed; pre-existing root README/package/lock/untracked user work was preserved.72 discovery tests pass; the whole repository retains one unrelated stale Pi1.3 assertion against pre-existing installed Pi1.4.

Reachable nodes macmini/ppc/wpc now run discovery0.2.1 with actual Pi1.4 and original provider `sub2api`. Macmini/ppc have34Factory pins; wpc only10FactoryClaude pins, no CodeMaker/DS/override edits or DS call. Online and offline SDK verification passed, including two registry views and cache-only second-registry zero-network checks. Urgent actual matrix passed8/8; all10Claude models on each of3nodes passed once in normal extension-enabled mode,30/30, exact model/provider/API, terminal completion, expected tiny output and no blocking warning. Previously tested Sonnet rows were not repeated. No user herdr pane was interrupted. MBA was unreachable after bounded checks, unchanged; ALIENWARE skipped/offline.

Final clean models rollback points (each node also retains its managed extension settings/opt-in backup, listed in the rollout guide):

- macmini: `/Users/clawbotbot/.pi/backups/factory-e-readd-2026-11-02T17-35-09-316Z/models.json`.
- ppc: `C:\Users\wo1fsea\.pi\backups\factory-e-readd-2026-11-02T17-45-01-788Z\models.json`.
- wpc: `C:\Users\gzhuangquanyong\.pi\backups\factory-e-readd-2026-11-02T17-53-44-396Z\models.json`.

Verification limits are explicit. Macmini SDK verification excluded a pre-existing broken Herdr user-extension symlink in a same-host scoped loader; actual normal Pi calls passed, but that unrelated extension was not repaired. Windows existing private DACLs were strictly checked and skipped without ACL writes; privileged SACL readback is unavailable and equality is not claimed. Installer-stage protected snapshots matched. WPC auth.json/models-store.json later changed around17:54 during normal Pi/concurrent activity; the exact writer/semantic delta is not proven, and all-credential/current-byte invariance is not claimed. The Sub2API key fingerprint is separately stable. Current auth/store files were preserved, never overwritten from old backups. This observation did not invalidate the evidenced startup/model function passes.

Independent final repair evidence: `/tmp/factory-discovery-final-independent-verify.md`, SHA256 `e5b9e1df15b8ca5c4d1f20161c62f579803aab4c80c88c550f746fa299f95b6e`. Durable per-node/model matrix, rollback points and limitations are in private pi-fleet `docs/model-discovery-v0.2.1-rollout.md` and sanitized evidence JSON; this repository's `docs/LOCAL_DELIVERY_FACTORY_0.2.19.md` records production/account closure. E0 owns the requested skill wording update; proposed sentence: "Model IDs may contain slash-separated namespaces such as factory/...; register them in the original providers.sub2api.models[] with exact override ID alignment, and require pi-fleet-model-discovery 0.2.1 or later." No skill or memory file was changed by this task.
