# Sub2API 源码调研（2026-09-26）

## 范围与结论

只读审查官方仓库、文档、release 和 issue；未访问既有部署、未读取密钥、未进行账号推理实测，也未执行源码测试。最新稳定版 v0.2.8 发布于 2026-09-23；main 为 a3eb7ef302961cba716dc78b39b93b60c467db0e，仅比该 tag 多一笔 VERSION 同步提交，差异文件只有 backend/cmd/server/VERSION，不能描述成 main 比稳定版多了一套功能。[1][2]

**用途判断（分析建议，非实测）**：对“两份本人 OpenAI 订阅、单台本地网关、Tailscale、多机器 Agent 自用”，Sub2API 的 OAuth 生命周期、Codex 特化转发、账号粘性、额度快照与暂停门很匹配。但它是账号池调度，不是把两账号余额合为一个上游额度池；不能据此承诺吞吐翻倍、完整 OpenAI API 等价、或全部 Agent 工具无缝兼容。

## 1. 订阅 OAuth 聚合

- **文档声明**：多账号 OAuth/API Key、粘性调度、用户和账号并发、token 计费与内置支付。[3]
- **源码确认**：OpenAI OAuth 有 PKCE、state 常量时间校验、code 交换、refresh token 保留逻辑；GetAccessToken 在过期前 3 分钟进入刷新路径。OAuth 转发到 ChatGPT 私有 Codex endpoint，API Key 转发到公开 OpenAI Platform 或自定义 base URL；不是将 ChatGPT 订阅变为官方付费 API key。[4][26][5]
- 对两个 OpenAI 账号，放在同一 OpenAI 分组即可形成候选池；无需跨供应商 composite。上游账号额度仍各自独立，故障切号不代表续链状态能跨账号迁移。（分析建议，依据选号与续链源码。）[6][11]

## 2. 调度、粘性、限流、额度刷新

- **源码确认**：高级调度包含 previous_response_id、session 粘性及负载候选；评分可用 priority、load、queue、错误率、TTFT、reset、quota_headroom、upstream_cost。关键默认：Reset=0、QuotaHeadroom=0；高级调度 runtime 初始为 false。因此“默认自动按剩余额度均衡用光两账号”是错误宣传。quota_headroom 实现偏向 7d 剩余，5h 余量不足 10% 再罚分；不是严格等比例消耗器。[6]
- **源码确认**：5h/7d quota auto-pause 可设账号阈值、继承全局阈值、逐窗口禁用。reset 到期或快照陈旧后不再据旧百分比永久暂停；auto-pause 陈旧界限为 2 小时。429 先解析 x-codex 窗口，used>=100 才按对应窗口 reset 冷却；瞬时429回落兜底，不把窗口存在误认耗尽。[7][8]
- **源码确认**：wham/usage 主动查询与 reset-credit consume 均有实现；token 刷新、查询额度快照、自然窗口重置、消费重置卡是四件不同的事。不能把“刷新额度”说成无限续费/增加订阅额度。[9]
- **源码确认**：AccountUsageService 有响应头探测/缓存刷新，openAIProbeCacheTTL=10分钟；普通账号 stale 刷新存在 WSv2 条件，probe 是 POST Codex responses，不全是零成本 metadata 查询。实际请求的用量头也可写快照，所以面板不是绝对实时的上游账本。[10]
- **文档注意**：Nginx 会丢弃含下划线的 session_id 等头；README 要求 underscores_in_headers on，否则账号粘性失效。[3]

## 3. Responses、WebSocket、工具兼容

- **源码确认的重要边界**：HTTP Responses 带 previous_response_id 时，handler 排除非 OpenAI API-key 账号；纯 OAuth 池会返回 400，消息为 previous_response_id requires an OpenAI API-key account for HTTP requests。Responses“存在”不等于 HTTP 服务端状态续链可用；客户端完整回放与 WS 续链须分开测试。[11]
- **源码确认**：OAuth 常规 Responses 强制 store=false、stream=true，并删除私有 Codex 不支持的字段。它是协议适配，不是透明地保留所有 OpenAI 请求语义。[25]
- **源码确认**：有 custom tools、tool_search、namespace 降级为 function 并恢复响应/历史的适配；同名冲突明确报错；工具 Schema 清洗包括 null type、null required、regex lookaround 等。删除 custom.format 或约束意味着“能通过上游校验”不等于工具语义完全等价；MCP/工具执行本身仍由 Agent 客户端承担。[12][13]
- **源码确认**：WS 长连接绑单一账号，后续 turn 重新获取用户/账号并发槽；利润门不合格会要求重连，不能连接内任意换号。因此不能保证另一个有额度账号能无缝接管已有工具续链。[11]
- **issue报告 + 源码印证（非本任务实测）**：#5735 报告标准订阅 WS 超日限额后旧连接仍能继续；当前 BeforeTurn 只追加 simple 可选 key-window 检查，未看到标准 subscription 逐 turn CheckBillingEligibility，仍不能称日限额为强硬上限。[20][11]
- **issue报告 + 源码印证（非本任务实测）**：#7368 报告 composite 自定义别名 HTTP可路由、WS拒绝；当前 WS 调 ensureCompositeTargetPlatform，而函数只按 DetectModelPlatform 命名检测，没有查显式 route registry。对纯 OpenAI 分组影响较小。[21][22]

## 4. API key 渠道与多租户计费

- **源码确认**：支持自定义 base URL、模型/端点能力与不同协议桥接；Responses 自动探测标记决定是否原生 Responses，部分不支持上游可转 Chat Completions，但 embeddings 必须 API Key。这不构成 new-api 所有渠道/供应商完整覆盖的证明。[5][14]
- **文档边界**：Composite 按模型选具体供应商；不实现抽象任务跨供应商 AUTO smart-routing，不允许 key 直接绑定多个既有分组，也不是 LiteLLM式全协议解耦。[24]
- **源码确认**：standard 模式有余额或分组订阅准入、key消费窗口、user/group RPM；user×platform quota 仅余额模式生效，subscription 模式豁免。RPM Redis失败 fail-open。计费 effects 与 request_id/api_key_id 幂等 claim 在同一数据库事务里，但这不是请求前额度预留或严格并发预算控制。[15][16]
- **文档+源码确认**：simple 跳过余额、订阅、平台额度扣费；可选 SIMPLE_MODE_KEY_RATE_LIMIT_ENABLED 开启 key 的5h/1d/7d美元消费窗口，默认 false，完成后记账可并发超限。网关账面 token 折算费用不应当作订阅真实现金消费或官方剩余token额度。[3][15]

## 5. 部署与许可证

- **文档+源码确认**：官方 Compose 含应用、PostgreSQL、Redis，自动初始化和迁移；也提供Linux二进制/systemd与Apple container。Apple方案文档明确无宿主机重启自启，Docker Compose仍是生产推荐；DB迁移 forward-only，回退需要恢复备份。[17][18]
- **源码确认默认风险**：Compose 默认 latest、0.0.0.0:8080、standard，URL allowlist默认 false，allow private hosts/insecure HTTP默认 true。自用建议 pin稳定镜像digest、127.0.0.1绑定、Tailscale Serve而非Funnel、关闭注册及不需的用户第三方登录、保护与备份数据库/refresh tokens；此为运维建议，未改部署。[17]
- **文档确认**：LICENSE 是LGPL v3，README称 v3或更高；但同一README又写“从未授权任何…商业化运营”。不要混成AGPL，也不要把宣传文案直接解释为LGPL条款。商业化前需核实许可及作者意图；本任务不作法律意见。[19][3]

## 6. 风险排序与建议验收

1. **上游服务条款/账号风控**：官方README明确承认可能违反上游ToS、封禁/中断风险。Tailscale只解决网关入站暴露，不消除ChatGPT私有endpoint或订阅使用方式风险。[3][5]
2. **真实工具续链**：HTTP OAuth previous_response_id限制、WS账号亲和与桥接语义变更，优先于UI模型数量判断。[11][12]
3. **调度设置**：剩余额度/reset评分默认不启用，快照有陈旧/探测条件；需以实际运行配置及真实quota窗口验收，不能只看有权重字段。[6][7][10]
4. **多租户软预算**：#5735与事后记账意味着销售拼车时需要额外审核预算强度；本人自用风险不同于公网经营。[20][15]
5. **安全与升级**：当前源码已有历史OAuth pending account-takeover终态护栏，不能因旧issue未关闭就声称v0.2.8仍有该已描述漏洞；亦不能凭这一个护栏宣称全站安全。[23]

**建议后续账号实测清单（本任务未执行）**：两账号逐一OAuth推理；两个独立session的account归属；完整工具调用→工具结果→二轮/并行工具；HTTP完整历史回放与previous_response_id预期失败；WS长任务/重连/compact；手动读取上游5h/7d与网关快照对照；阈值暂停、429、窗口reset后的账号再准入。只有这些验收才能声称“本人两订阅聚合且真实Agent兼容”。

## Sources

[1] https://github.com/Wei-Shaw/sub2api/compare/v0.2.8...a3eb7ef302961cba716dc78b39b93b60c467db0e — main/release对比
[2] https://github.com/Wei-Shaw/sub2api/releases/tag/v0.2.8 — 稳定版v0.2.8
[3] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/README_CN.md — 官方中文README
[4] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/openai_oauth_service.go — OpenAI OAuth与刷新
[5] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/openai_gateway_forward.go — 上游OAuth/APIKey分流
[6] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/openai_account_scheduler.go — 调度权重与默认值
[7] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/openai_gateway_scheduling.go — 额度自动暂停与复原
[8] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/ratelimit_service.go — OpenAI429冷却计算
[9] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/openai_quota_service.go — 用量查询与重置卡
[10] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/account_usage_service.go — 用量探测刷新
[11] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/handler/openai_gateway_handler.go — Responses HTTP/WS handler
[12] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/pkg/apicompat/responses_client_tools.go — Codex客户端工具适配
[13] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/openai_responses_tool_schema.go — 工具Schema清洗
[14] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/account.go — 账号端点能力
[15] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/billing_cache_service.go — 多租户计费准入与simple模式
[16] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/repository/usage_billing_repo.go — 事务与计费幂等
[17] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/deploy/docker-compose.yml — Docker部署配置
[18] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/deploy/README.md — 部署官方文档
[19] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/LICENSE — LGPLv3许可证
[20] https://github.com/Wei-Shaw/sub2api/issues/5735 — WS订阅日限额issue
[21] https://github.com/Wei-Shaw/sub2api/issues/7368 — Composite WS路由issue
[22] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/handler/composite_platform.go — Composite WS按名检测源码
[23] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/handler/auth_oauth_pending_flow.go — 历史OAuth账号接管修复护栏
[24] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/docs/COMPOSITE_GROUPS.md — Composite官方文档
[25] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/openai_codex_transform.go — OAuth Responses参数变换
[26] https://github.com/Wei-Shaw/sub2api/blob/a3eb7ef302961cba716dc78b39b93b60c467db0e/backend/internal/service/openai_token_provider.go — Token过期刷新
