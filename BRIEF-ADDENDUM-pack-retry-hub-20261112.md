# BRIEF-ADDENDUM：QH 令继续打包（Docker Hub 复测已通）

时间：2026-11-12 ~10:45 Asia/Taipei。同一任务、同一 tab（cutover-0.2.21-a8314a / t29），不要 /clear，保留 NOTES。

QH 在本 P0 聊天里回复「继续」，针对的是 P0 说「Docker Hub 现已通，你要是说继续，我就让 Astra 再打包」。这是同一条 a8314a 切流的打包续做，不是放宽「不写现网库」。也不要去碰并行的 Magpie 安装任务。

## Docker Hub 复测结论（P0 只读 + 同构建器最小验证，已把 builder 停回）
- 失败点仍是当时 BuildKit 解析 `# syntax=docker/dockerfile:1.7` 时，向 auth.docker.io 要匿名 token 遇到 EOF。macmini 无 Docker Hub 账号，一直匿名拉取，不是缺登录凭据。
- Clash 里 docker.io / auth.docker.io 的 DIRECT 规则仍在。
- 复测时本机与 Colima 匿名 token 均为 HTTP 200；同一 builder `sub2api-release-20261002` 解析 Dockerfile frontend + 拉 alpine:3.21 metadata 成功（build_exit=0），随后已将 builder 停回 stopped。
- 更像当时偶发 EOF。本轮直接再打包，不要先改 Clash。若再次 EOF 或 Hub 不通：硬阻断并写清，不要改 Clash 全局规则、不要写现网。

## 现网（本轮开始时，不要改）
- 仍是 sub2api-local:0.2.19-466dc86d2eec / sha256:ed98069e97165ce50a1286cd7707fa250c8b864e4651ab63cad0d3ce1e5b1655，healthy，StartedAt 2026-11-08T08:53:42.616998344Z（2026-11-08 16:53:42 Asia/Taipei），RestartCount=6。
- Data 盘约 15Gi 可用（93%）。主机空闲 <3Gi 或 Docker 数据空闲 <5Gi 则硬停。不要删现网镜像/卷/backup-Omp0Fv，不要停无关进程。

## 工作树
- 当前 detached HEAD 是 d67bc1ccf（docs: Hub EOF 阻断记录），其父为 0de7d886a56b（只读切流改造 + vue-tsc 串行修复，已测过 85 项与完整 vue-tsc -b）。
- 从**当时干净的实际 HEAD** 打包，tag 用 `sub2api-local:0.2.21-<12-char HEAD>`，不要手填，不要 amend a8314a689286，不要 push。

## 并行任务（硬隔离）
此时另一 tab `magpie` / `install-docker`（pane t2b）正在旁路安装 Magpie。预检时已有容器名 `magpie` 处于 Created、镜像 `ghcr.io/yetone/magpie:latest`。
- 不要停、删、改名、占用 `magpie` 容器或 `magpie-config` 卷，不要写 `/Users/clawbotbot/Projects/magpie`。
- 不要改 Tailscale Serve（默认 https 仍指向现网 18480）。
- 打包仍用自己的 builder `sub2api-release-20261002`。若与 Magpie 抢 Docker 资源或盘位告急，硬停并报告，不要为打包杀掉 Magpie。

## 继续顺序（与此前 pack-cutover 口径相同，未放宽）
1. 确认 prepare/activate 仍不向现网 /auth/login POST、不以现网新 usage 行为门；SQL 只读事务。
2. 再打包。内存口径保持：完整 vue-tsc 串行，不在 Vite 阶段重复 checker，不跳过 typcheck，不首先加内存。
3. 成功后做**新的受保护备份**，保留 backup-Omp0Fv。
4. 用非空现网库副本演练 248 兼容路径（三份 249/250 文件保持未应用）。空库演练通过不能作为可 activate 条件。
5. 仅当 .env / 现网库 / 249-250 都未被动过，才 prepare/activate。
6. 若任一步会写现网库、改 .env、应用 249/250，或打包再失败：硬停并写 NOTES/报告，不要 activate。

仍禁止：改 .env、写现网库、假写 schema_migrations、应用 249/250、改恢复程序（除非有只读证据证明 0.2.21 再次被拒）、重启/重登 oauth #1、把密钥写进 NOTES 或聊天。

完成后在 NOTES 写清：实际 image tag / digest、health、StartedAt/RestartCount、.env/库/249-250 是否未动、备份 id、以及相对本 addendum 做了什么。然后停在本 tab 等 P0。
