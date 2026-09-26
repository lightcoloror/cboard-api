# 图语家 API 腾讯云轻量服务器部署手册

> 状态：服务器主机基线和备案期间私有预部署已完成；CBoard API、MongoDB、Caddy 正在服务器回环地址运行。域名 ICP 备案仍在等待腾讯云初审，DNS、公开 HTTPS 与微信真机公网链路尚未开放。
>
> 最近更新：`2026-09-11 18:18:53`；执行工具 / 模型：`Codex（GPT-5）`。

## 目标

在不绑定具体云厂商增值服务的前提下，把 CBoard API、MongoDB 和 HTTPS 入口作为一套可重复部署、可检查、可备份、可恢复的基础设施。第一版即使暂不购买短信、Azure 私有图库、AI 或方言识别，也能运行基础账号与设置同步服务。

## 变动记录

### 最小生产配置

- 意图：让尚未购买可选云服务的项目也能准备并验证生产配置。
- 决策：MongoDB、会话密钥、JWT 密钥、HTTPS 域名和限流配置为必需；Azure 私有图库与腾讯短信改为显式启用后才必需。
- 理由：可选供应商不应阻止基础 API 上线，但启用后的凭据缺失必须失败关闭。
- 证据：`npm run verify:production-deploy-template` 和生产部署配置单元测试。
- 生效范围：`deploy/.env.production.example`、生产配置检查器及 Docker Compose 环境变量。

### 一键部署与健康检查

- 意图：减少首次部署时手工输入错误。
- 决策：`deploy.sh` 必须先校验配置和 Compose，再构建启动，最后通过公网 HTTPS `/health` 验收。
- 理由：容器启动成功不等于用户手机可以访问，HTTPS 健康检查才是发布前最低证据。
- 证据：脚本静态检查与部署配置检查器；真实公网证据要等购买服务器、域名并解析后补充。
- 生效范围：腾讯云轻量应用服务器或任何支持 Docker Compose 的 Linux 主机。

### MongoDB 备份与恢复

- 意图：防止用户图板、设置和账号数据因升级或误操作丢失。
- 决策：备份默认保留 14 天并使用权限受限的压缩归档；恢复必须显式设置 `CONFIRM_RESTORE=RESTORE`，且默认使用 `--drop` 做完整恢复。
- 理由：自动备份应容易执行，破坏性的恢复必须难以误触。
- 证据：脚本会拒绝空备份、非法保留天数、空归档和未确认恢复。
- 生效范围：生产 Docker Compose 中的 MongoDB 数据。上线后仍需把备份复制到另一存储位置，避免服务器整机损坏时同时丢失原库和备份。

### 安全生成生产环境配置

- 意图：避免第一次部署时手工生成弱密钥、重复密钥，或把真实密钥输出到终端记录。
- 决策：使用 `npm run prepare:production-env -- <API 域名> <证书联系邮箱>` 从受控模板生成 `deploy/.env.production`；生成器使用独立随机密钥、拒绝覆盖已有文件，并在写入后立即执行生产配置校验。
- 理由：域名和服务器可以稍后购买，但密钥生成与配置校验流程应先固化并经过测试。
- 证据：生成器单元测试覆盖有效配置、非法域名/邮箱、弱密钥、重复密钥、npm 位置参数和拒绝覆盖；本地隔离 Mongo 演练使用生成配置通过真实容器启动。
- 生效范围：未来首次生产部署的基础 MongoDB、会话、JWT 和图符代理密钥；不生成短信、AI、OCR、Azure 或方言服务凭据。

购买域名并确定证书联系人邮箱后，在服务器仓库目录执行：

```bash
npm run prepare:production-env -- api.example.com admin@example.com
```

命令成功后只报告配置文件路径，不打印任何密钥。若文件已经存在，命令会拒绝覆盖；需要更换配置时必须先人工备份并明确处理旧文件。

### 主机安全基线

- 意图：在部署任何用户数据或公网服务前，先建立可恢复、最小暴露的服务器入口。
- 决策：使用独立 SSH 私钥登录；关闭密码登录、root 登录和键盘交互认证；启用 UFW，当前仅允许 SSH 端口；启用自动安全更新。
- 理由：密钥登录可降低弱密码和暴力破解风险；备案与应用尚未完成时没有必要提前开放 HTTP、HTTPS 或数据库端口。
- 证据：重启后的新 SSH 会话登录成功；`sshd -T` 显示 `passwordauthentication no`、`permitrootlogin no`、`pubkeyauthentication yes`、`maxauthtries 3`；UFW 为 `deny incoming` 且仅放行 OpenSSH；监听端口只有 SSH 和本机 DNS。
- 生效范围：腾讯云广州轻量应用服务器的主机登录与入站网络；腾讯云控制台安全组仍需保持相同的最小开放策略。

### 容器运行环境与资源保护

- 意图：为 CBoard API、MongoDB 与 Caddy 提供可复现的容器运行环境，同时避免 4 GB 内存和 40 GB 系统盘被突发内存或无限日志耗尽。
- 决策：从 Docker 官方签名 apt 仓库安装 Docker Engine、Buildx 和 Compose 插件；配置 2 GiB swap；将默认日志驱动设为 `local`，单文件上限 10 MiB、最多 3 个文件；不把 `ubuntu` 用户加入具有 root 等价权限的 `docker` 组。
- 理由：生产主机应使用受支持的软件源和有界日志；swap 只作为突发保护，不能代替内存容量；保留 `sudo docker` 可减少常驻 root 等价权限。
- 证据：Ubuntu `22.04.5 LTS` 已升级并重启到内核 `5.15.0-191-generic`；Docker `29.8.0`、Compose `5.5.1`、containerd 与自动更新服务均为 active/enabled；swap 为 2 GiB；待更新包与失败 systemd 单元均为 0。
- 生效范围：服务器主机层与后续新建容器；不代表 CBoard API、MongoDB、备份、DNS 或 HTTPS 已部署完成。

### 腾讯云内网公共镜像加速

- 意图：解决中国大陆服务器访问 Docker Hub 时 TLS 被重置，导致公共基础镜像无法拉取的问题。
- 决策：仅配置腾讯云官方、只支持腾讯云内网访问的 `https://mirror.ccs.tencentyun.com`，保留 Docker 官方软件包仓库，不加入第三方公共镜像站，也不向镜像站发送私有仓库凭据。
- 理由：图语家生产编排依赖 Node、MongoDB 和 Caddy 公共镜像；使用云厂商内网镜像比未知反向代理更可控。
- 证据：镜像端点 `/v2/` 返回 HTTP 200；`docker info` 显示该 Registry Mirror；`hello-world` 镜像成功拉取并运行，退出后活动容器为 0。
- 生效范围：该腾讯云实例拉取 Docker Hub 公共镜像；私有镜像、镜像签名和供应链审计仍需单独配置。

### 可重复主机初始化

- 意图：避免首次服务器配置只存在于终端历史，后续无法复核或重建。
- 决策：新增 `deploy/scripts/bootstrap-lighthouse.sh`，限定 Ubuntu 22.04，采用幂等步骤配置系统更新、Docker、日志、swap、自动安全更新、SSH 与 UFW；生产部署检查器同时验证这些关键保护项存在。
- 理由：可审查脚本比一次性手工命令更容易发现风险、复现配置和交接维护。
- 证据：服务器端 `bash -n` 通过，本地 `npm run verify:production-deploy-template` 与部署检查器 8 项单测通过；同一脚本重复执行后所有步骤保持成功。
- 生效范围：图语家腾讯云轻量服务器的主机初始化，不负责生成业务密钥、启动业务容器或变更 DNS。

### 备案期间私有预部署

- 意图：在 ICP 备案完成前，先验证真实腾讯云服务器能否运行 CBoard API 与 MongoDB，提前发现镜像、依赖、资源和持久化问题。
- 决策：新增独立私有配置生成器和部署脚本；Caddy 只能绑定 `127.0.0.1` 的高位端口，使用内部测试证书，并通过 SSH 内部健康检查验收。
- 理由：备案限制正式公网开放，不妨碍服务器内部建设；显式私有配置可避免误把生产 Compose 的 `80/443` 暴露到公网。
- 证据：私有部署检查器拒绝 `0.0.0.0`、低位端口、重复端口和非本地 Caddy 配置；真实服务器已完成镜像构建，MongoDB 和 API 均为 `healthy`，`/health` 返回数据库已连接和通信索引已就绪。宿主机仅在 `127.0.0.1:18080/18443` 监听 Caddy，API `10010` 与 MongoDB `27017` 均未发布；从外部检查 `80/443/18080/18443/10010/27017` 均不可达。三个容器合计约占用 `521 MiB` 内存，MongoDB 重启后的专用测试标记成功读回，测试数据库随后已删除。
- 生效范围：备案等待期内的服务器本机测试；不包括 DNS、公开 HTTPS、微信合法域名或真实用户访问。

### 原生 Node 依赖构建回退

- 意图：确保服务器访问预编译二进制不稳定时，API 镜像仍能按锁文件完成可重复构建。
- 决策：仅在 Docker 依赖构建阶段安装 Python 3、Make 和 C++ 编译器，允许 `better-sqlite3` 回退到源码编译；最终运行阶段继续使用不含编译工具的精简镜像。
- 理由：中国内地服务器访问上游预编译产物和 Debian 默认软件源可能超时，单纯依赖下载会使首次部署随机失败；多阶段构建可在保证可靠性的同时控制运行镜像攻击面和体积。
- 证据：首次腾讯云构建在预编译下载超时后因缺少 Python 失败；后续 Debian 默认源在容器内无活动连接却长期停滞。腾讯云官方软件源的 Debian 与 Debian Security 地址均从同一容器成功完成签名索引更新，9.3 MB 索引约 1 秒下载完毕，随后成功安装 CA 证书和编译工具；腾讯云私有配置显式使用这两个内网镜像，其他环境仍保留 Debian 官方默认值。最终 API 镜像构建成功；运行容器使用 `node` 用户且不含 Python、Make 或 C++ 编译器。
- 生效范围：API Docker 镜像的依赖安装阶段，不改变宿主机软件、运行时业务逻辑或公网暴露范围。

### 安全主机上的备份与恢复

- 意图：让 MongoDB 备份与恢复脚本在不把 `ubuntu` 用户加入 Docker 管理组的前提下仍可执行。
- 决策：备份和恢复脚本复用受控 Docker 命令解析，显式读取并校验 Compose 项目名；失败时自动删除零字节备份，恢复继续要求 `CONFIRM_RESTORE=RESTORE`。
- 理由：Docker 管理组具有近似 root 权限，不应仅为日常备份放宽主机安全边界；私有预部署与未来生产部署的数据卷也必须明确隔离。
- 证据：脚本静态门禁与本地单元测试通过；腾讯云真实生成 `mongo-20260911T101847Z.archive.gz`，权限为 `600`，归档非空且通过 `gzip -t` 与 `mongorestore --dryRun`。本轮没有执行真实恢复，避免无必要地改写数据库。
- 生效范围：`cboard-api-private` 和未来 `cboard-api-production` 的 MongoDB 归档操作，不改变数据库网络暴露或保留周期。

在服务器仓库目录执行：

```bash
chmod +x deploy/scripts/*.sh
./deploy/scripts/prepare-private-env.sh
./deploy/scripts/deploy-private.sh
./deploy/scripts/verify-private-persistence.sh
```

宿主机未安装 Node.js 时，脚本会通过无网络权限的 Node 容器生成和校验配置。生成的 `deploy/.env.private` 权限受限且不会进入 Git。私有服务仅可在服务器内部通过 `https://localhost:18443/health` 验证。持久化验收脚本只使用专用测试数据库，重启 MongoDB 并读回标记后会立即删除测试数据。

## 当前上线步骤

1. [x] 购买腾讯云广州轻量应用服务器并完成主机初始化。
2. [x] 购买 `tuyujia.com.cn` 并完成域名实名认证。
3. [ ] 完成域名 ICP 备案；当前等待腾讯云初审，备案完成前不解析并对外提供服务。
4. [ ] 完成微信小程序备案与服务类目、隐私保护指引核对。
5. [ ] 将 `api.tuyujia.com.cn` 解析到服务器，并在腾讯云安全组与 UFW 中仅新增 HTTP、HTTPS；MongoDB 27017 和 API 容器 10010 不对公网开放。
6. [x] 已按基线提交 `202c306fe0059cbf93ec391e34e456f73448abe3` 与本轮可审查补丁检出到服务器，并完成私有预部署；正式上线前仍需把补丁形成提交并重新核对 SHA。
7. [ ] 使用上方 `prepare:production-env` 命令生成并校验 `deploy/.env.production`，不要把真实配置提交到 Git。
8. [ ] 执行：

```bash
chmod +x deploy/scripts/*.sh
./deploy/scripts/deploy.sh
```

9. [ ] 通过公网 HTTPS `/health`、证书续期模拟、容器重启和 MongoDB 备份恢复验收。
10. [ ] 在微信公众平台把 `https://api.tuyujia.com.cn` 配置为合法的 request、uploadFile 和 downloadFile 域名。
11. [ ] 将微信小程序生产环境中的 API 地址和已具备合规条件的功能开关改为正式值，重新构建、预览和提审。

## 日常操作

```bash
# 健康检查
./deploy/scripts/health-check.sh

# 创建本地服务器备份
./deploy/scripts/backup-mongo.sh

# 仅在 API 已停止、目标与归档已人工核对后恢复；恢复后不直接重启 API
CONFIRM_RESTORE=RESTORE ./deploy/scripts/restore-mongo.sh \
  deploy/.env.production deploy/backups/mongo-时间.archive.gz
```

### 恢复后的安全状态核对（尚未完成自动化）

更新：2026-09-18 11:42:00 | Codex (GPT-6 Astra)

- 意图：恢复数据时不恢复已失效的登录、成员授权或已注销账号的访问。
- 决策：当前脚本只完成离线数据库恢复，拒绝在 API 运行时执行，也不会自动启动 API。恢复结束不等于业务可恢复开放。
- 理由：全库 `mongorestore --drop` 会回退 `devicesessions`、`users`、`careaccountlifecycles` 及家庭授权等状态。备份之后发生的退出、改密、撤权、注销可能不在归档中。
- 证据：`deploy/scripts/restore-mongo.sh` 使用全库归档；`api/helpers/deviceSessions.js` 从 MongoDB 检查会话及账号状态；密码重置凭据与消费状态实际位于 `resetpasswords`（`api/models/ResetPassword.js`），邮件注册确认位于 `temporary_users`（`api/mail/email-verification.js`），手机验证位于 `phoneVerificationChallenges`。现有停机保护只防止恢复过程中继续服务，不解决安全状态回退。
- 生效范围：运维操作说明和公开试用验收边界；本段不执行密钥轮换、数据清理或线上恢复。

恢复演练和真实故障处理应分开记录：

1. 优先将归档恢复到独立实例，保持 API 停止，验证数据库、加密媒体及密钥配套完整；不得将健康检查作为恢复验收。
2. 对照**备份之外、更新至故障时点的证据**，核对并重放注销、家庭关闭、成员撤权及账号安全变更。只读取已恢复数据库无法证明这些变更没有丢失。当前尚未建立完整的独立记录与重放流程；缺失时不得宣称可安全重新开放。
3. 开放前使旧登录凭据失效，并清除可从备份恢复的临时找回/验证凭据。JWT 与会话密钥轮换属于已有配置机制，但只能处理对应凭据；不能代替注销资料清理、最新密码状态和授权核对。共享数据加密密钥另行管理，不能随登录密钥丢弃。
4. 在隔离环境验证“备份 → 退出/改密/撤权/注销 → 恢复”的顺序；旧令牌、旧找回链接和已撤权媒体访问必须拒绝，已注销资料不得重新暴露。同时验证合法账号重新登录和可保留资料的恢复。
5. 保存上述证据、确认回滚目标后，另行安排恢复服务。现有脚本的成功输出仅表示 MongoDB 命令完成。

公开试用前，此项仍为未完成。当前合成数据恢复演练不覆盖全部安全状态回退场景。

## 尚未完成的真实验收

- 域名 ICP 备案仍在腾讯云初审阶段，因此尚未解析 API 子域名，也未验证公网 HTTPS、证书自动续期或微信真机网络请求。
- CBoard API、MongoDB 与 Caddy 已在服务器回环地址私有运行，并通过健康检查、容器重启、MongoDB 持久化和备份恢复预演；它们尚未绑定域名或向公网开放，因此仍不是业务上线。
- 没有异地对象存储，因此当前脚本只准备服务器本机备份；正式试用前至少要人工下载一份备份或配置另一处加密存储。
- 没有购买短信、AI、OCR、在线补图和方言识别供应商服务，因此这些能力应在微信生产构建中保持关闭。
## 本地容灾演练证据

- 时间：`2026-07-30 21:29:43`
- 执行工具 / 模型：`Codex（GPT-5）`
- 意图：在购买服务器前验证生产 MongoDB 备份与恢复所依赖的真实命令，而不只做静态脚本检查。
- 决策：使用独立 Compose 项目 `picinterpreter-drill`、独立网络和独立数据卷；只操作测试数据库 `picinterpreter-drill`，演练结束后删除容器、网络、卷和临时密钥。
- 理由：恢复命令具有破坏性，必须先在完全隔离的本地环境证明备份非空、修改后可恢复且不会接触开发库或未来生产库。
- 证据：MongoDB `7.0.37` 容器达到 `healthy`；写入值 `before-restore`；生成 `364` 字节 gzip archive；将值改为 `after-backup`；以 `mongorestore --drop` 恢复后读回 `{"_id":"backup-proof","value":"before-restore"}`；隔离容器和卷随后成功删除。
- 生效范围：证明 Docker Mongo 的 `mongodump` / `mongorestore` 核心路径在当前电脑可用；不等于部署脚本已在真实 Linux 服务器、定时任务或异地存储上验收。

### 恢复后的部署阻断标记

更新：2026-09-18 14:18:21 | Codex (GPT-6 Astra；Terra只读复核)

- 意图：避免全库恢复后直接执行部署脚本，重新开放备份中的旧会话、旧授权或已注销账号。
- 决策：restore-mongo.sh 在目标、确认、归档及API停机检查通过后，先在主机 deploy/.restore-security-review-required.<Compose项目名> 创建私有权限标记，再执行 mongorestore。成功、失败及中断均不自动清除标记；deploy.sh 和 deploy-private.sh 在任何 compose config/up 前遇标记即拒绝继续。已有普通文件标记保留，异常文件或符号链接拒绝恢复。
- 理由：标记位于数据库卷之外，不随全库恢复回退；恢复命令成功不能证明故障时点的权限、注销及凭据状态已重新核对。项目名区分同一目录中的不同部署。
- 证据：对应 shell 回归记录见本轮源码账本；本改动仅为本地代码，尚未安装到服务器。
- 生效范围：同一项目 checkout 下这些受支持脚本。隔离 restore_scheduled_trial.py 演练不重新开放源API，不使用此标记。直接 docker compose start/up、另一个checkout及独立私有更新器不受此文件门禁保护，不能用这些路径绕过安全核对。

不要把删除标记当作恢复步骤。只有已完成上一节要求的独立安全状态核对、旧凭据失效和注销/撤权恢复验证，并保留证据、明确安排恢复服务后，才可由运维人员处理对应标记。没有自动清除命令或一次性绕过参数；当前独立记录与重放流程仍未完成，因此不能仅凭此门禁声称已可安全恢复公开服务。

### 2026-09-18 15:10:14 | Codex (GPT-6 Astra；Luna配置透传与回归) | 注册邮件部署合同
- 意图：避免部署成功后才发现注册邮件缺少发件人或验证链接指向错误地址。
- 决策：沿用现有production Sendgrid transport与configuredEmailAppOrigin，Compose新增EMAIL_FROM/AUTH_EMAIL_APP_URL透传，示例留空并说明用途。checker在任一邮件专用参数已配置或PUBLIC_TRIAL=true时要求EMAIL_FROM和SENDGRID_API_KEY，拒绝发件人换行，并按运行时相同规则校验HTTPS应用origin；AUTH_EMAIL_APP_URL为空时仍回退CBOARD_APP_URL。不新增邮件供应商或发送系统。
- 理由：生产模块已读取这两个变量，但Compose原先未传；复用同一origin校验避免部署与请求行为不一致。非试用且完全未配置邮件的旧部署仍可使用本机功能。
- 证据：受管codex-test-71692-72a2c0e335c94dc692d92193b3f25b7b共19项通过，覆盖邮件参数完整性、origin回退/拒绝路径/凭据/query、错误不输出秘密、Compose映射与运行时名称一致，以及原部署生成器回归。已读最终日志，git diff --check通过。初次并行测试73000-3ae9521d8caf461787ba3e6b1a6b2dd9因新测试projectRoot未定义失败，修正后重跑通过，保留失败记录。
- 生效范围：本地配置模板、checker和测试；不等于实际容器启动或真实收件箱投递，没有购买邮件服务、发送邮件或部署。当前标准Compose的Care事务/开关/存储合同仍未补齐，不能以本次19项通过宣布公开试用就绪。未打开或置顶微信窗口。

### 2026-09-18 15:16:00 | Codex (GPT-6 Astra；Luna参数校验；Terra复用合同及复核) | Care部署参数接线
- 意图：让家庭协作开关、加密、配额与试用策略从部署配置实际传入API，并提前发现缺失或相互冲突的参数。
- 决策：base Compose透传Care核心开关、active key/keyring、trial/AI policy、家庭媒体配额、private container及试用限流；模板所有功能默认false，密钥/商业策略留空，不发放真实权益。主部署checker接入checkCareDeploymentConfiguration：复用运行时trial与quota校验、内存seal/open探针，并从careAiMetering抽取共享price validator，避免部署与计费规则分叉。PUBLIC_TRIAL要求协作/next/事务/注销确认开启；Mongo仅检查replicaSet参数存在。
- 理由：已有业务模块和私有验收足以复用，无需重写账号或额度服务。参数可解析不证明存储、事务或后台调度可运行，因此本步只是正式部署链路中的配置部分。
- 证据：受管codex-test-53972-96fd5736d54e44ed94a7b175f06fd578共30项通过，含Care参数、计价/结算/幂等、邮件、原部署校验及环境生成器；日志已读取。Terra复核确认价格条件等价、错误不泄密、Mongo检查仅语法。git diff --check通过。
- 生效范围：本地源码和配置模板；未启动容器、未连接数据库、未部署或变更现有服务。标准base Compose仍是standalone Mongo，不具备完整Care运行条件，不能凭configuration valid输出启用公开试用；专用override/初始化入口/媒体持久卷/worker调度仍需完成。没有置顶微信窗口。
- 下一部署步骤的复用依据：prepare_trial_replica.py与upgrade_trial_replica_remote.py已有replSet/keyfile/认证primary/事务abort探针，但旧升级顺序不能直接用于带closure worker的当前系统。须复用care_backup_quiesce.py先暂停closure timer、等待worker自然退出、再停API并备份；恢复API健康后再恢复timer。正式入口需显式组合base与Care override并隔离project/env，保持keyfile受限权限及API/worker共享媒体卷。单节点副本集不等于高可用，异地备份与独立安全状态恢复仍未解决。

### 2026-09-18 15:34:19 | Codex (GPT-6 Astra；Terra Compose适配；Luna脚本测试) | 独立Care初始化入口
- 意图：为家庭协作提供具备Mongo事务和持久化私有媒体的独立部署入口，避免误用旧standalone部署或触碰已有数据库。
- 决策：新增docker-compose.care.yml，显式与production base组合，Mongo使用care-rs及只读keyfile，媒体使用独立命名卷。initialize-care.sh要求显式环境文件、--initialize-empty及cboard-care-*项目；拒绝已有容器、卷、同名网络和恢复保护标记，资源查询失败即停止。校验keyfile常规绝对路径、0400和镜像Mongo UID；仅临时媒体权限助手增加CHOWN，长期API仍保留cap_drop ALL。执行认证就绪、primary和事务提交/回滚探针后启动内部API，不启动Caddy或注销调度。失败保留资源，不自动删卷或重复初始化。
- 理由：复用现有Compose、deployment checker、docker-runtime及私有副本集流程，无需重造部署系统；基础配置可解析不等于事务或文件权限实际可用。临时助手先chmod再chown，以适配基础镜像权限限制。
- 证据：本轮重新读取受管日志：codex-test-23504-b3392e625466490ebef3692e1927a25f共9项脚本测试通过；codex-test-80328-e6b500e394c1443fa21adbb60e0491b6实际Docker Compose合并解析1项通过；codex-test-71024-af7f20e5cb08425687509d5034611133环境生成器5项回归通过。脚本测试的Docker、Node配置检查及stat为隔离替身；Compose测试只解析配置，不调用daemon。早期Windows spawn和stat替身优先级失败保留日志，最终用测试BASH_ENV修正，没有修改系统权限或放宽脚本检查。
- 生效范围：本地源码、模板、测试与文档，未启动真实容器、未部署现有服务器、未上传腾讯。真实Linux权限、容器启动、事务和媒体读写仍须隔离环境验收；新入口尚无正式worker调度及配套备份/升级/恢复包装。单节点副本集不代表高可用；异地备份、独立安全事件恢复、邮件、最终备案及真机验收仍未完成。六项目标保持未完成。全程后台，未打开或置顶微信窗口。

### 2026-09-18 15:38:13 | Codex (GPT-6 Astra；Terra目标隔离审查) | Mongo连接目标严格校验
- 意图：确保独立部署的API/worker实际连接本项目内部Mongo，不能因配置校验误判而连接外部数据库。
- 决策：checkProductionDeployment复用Node URL解析，要求含配置凭据的准确mongodb://authority前缀、真实hostname=mongo、port=27017、无fragment，以及唯一且准确的authSource=admin。initialize-care已在资源操作前调用该checker，随后执行care-rs与directConnection检查，未新增第二套解析模块。错误保持固定文案，不输出URI或密码。
- 理由：旧includes检查可被放在appName查询参数中的预期authority满足；实际主机仍是另一地址。该反例同时会通过初始化入口原有replicaSet检查，属于真实部署隔离缺口。
- 证据：受管codex-test-71956-4b338096b61d404da0f5cb978a733c17日志已读取，22项通过；新回归覆盖外部主机伪装查询值、重复authSource、administrator前缀、fragment和非法URI，原生产/私有环境生成与Care配置回归保持通过。
- 生效范围：本地部署预检及测试，未更改现有数据库或服务器配置；不宣称真实容器/事务验收。没有访问外部反例地址。六项目标仍未完成，微信窗口未置顶。

### 2026-09-18 15:40:40 | Codex (GPT-6 Astra；Terra驱动语义复核) | Mongo选项大小写一致性
- 意图：避免部署校验与现有Mongo驱动对查询参数大小写处理不同，导致直接连接或重复选项漏检。
- 决策：Care配置检查按小写参数名拒绝directConnection任意大小写，并要求replicaSet唯一；production检查按小写名称计数authSource，仍要求标准authSource=admin。初始化入口在资源操作前调用这些现有checker。
- 理由：本仓node_modules/mongodb/lib/core/uri_parser.js先将key转小写；原URLSearchParams.has仅识别精确大小写，DIRECTCONNECTION=true可漏过。统一驱动语义不需要新增依赖。
- 证据：实际读取受管codex-test-11360-90aa3d8274ba4f64813a9401934bce1c日志，23项通过，包含大小写directConnection、重复/混合大小写replicaSet和重复authSource，保留原合法环境通过。
- 生效范围：本地配置检查及测试，无数据库连接或部署操作，不能代替真实事务验收。没有打开微信窗口。

### 2026-09-18 15:42:33 | Codex (GPT-6 Astra；Luna实现及测试；Terra运行合同复核) | 正式Care注销批次入口
- 意图：让正式独立Care项目复用现有注销worker，同时避免恢复隔离被后台任务绕过、重复批次或误启动已停服务。
- 决策：新增run-care-closure.sh，显式读取环境文件，只接受cboard-care-*及worker开启配置，先检查恢复标记。通过Compose project/service标签定位唯一运行API，再inspect固定容器ID、身份及healthy；只exec已有容器。运行容器内非阻塞flock、90秒TERM/5秒KILL timeout和128MB Node heap，保留worker/超时/锁冲突非零退出码。容器自身worker配置也必须开启，不通过exec强行覆盖。Dockerfile新增timeout/flock存在性构建检查，运行入口再次检查。
- 理由：直接复用runCareClosureWorker.js及发行版工具，不复制账号清理实现、不在宿主输出URI或密钥。单容器文件锁限制本入口并发，不能替代数据库幂等或跨容器协调。每次执行检查restore hold，使调度入口与部署恢复隔离一致。
- 证据：实际读取codex-test-40092-e3bf126bcbf74fbebdde1832720eac71日志，12项通过，覆盖项目/开关/恢复标记、停止/多容器/错误标签/不健康、工具缺失、成功/失败/超时/锁冲突状态。执行真实shell脚本，Docker和Node配置读取为替身；锁冲突与timeout退出为模拟，不是实际并发或超时容器实验。
- 生效范围：本地脚本、测试和Dockerfile构建前提，未构建镜像、未运行真实worker、未安装systemd或更改服务器。现有备份停timer→排空worker→停API→恢复API健康→恢复timer的流程仍需为正式项目参数化并联调；此次入口不能单独证明安全备份窗口。正式调度/真实镜像能力与备份联调仍未验收。全程后台，未打开微信窗口。

### 2026-09-18 15:45:33 | Codex (GPT-6 Astra；Terra备份复用审查) | 拒绝独立Care数据库单包备份
- 意图：避免新家庭协作部署误用旧数据库单包脚本，得到缺少患者媒体与恢复密钥却显示成功的备份。
- 决策：backup-mongo.sh对cboard-care-*项目在创建输出目录、mongodump及旧保留清理之前拒绝，明确要求数据库、私有媒体及独立密钥的协调备份。既有legacy项目行为保留。
- 理由：旧脚本只有在线dump及按天删除，未排空API/closure写入，也不包含命名媒体卷和密钥。完整Care入口应复用已验证trial的partial原子发布、完整性校验、容量策略与维护窗口，再适配正式项目，而非把单包结果标为可恢复。
- 证据：已读取受管codex-test-7680-9ce9b2b0787b4ef4b2596638230b2601日志，22项通过，新测试确认没有创建目录、执行dump/Compose；原备份成功/失败、恢复保护及部署回归通过。初次9692-ae9c37a0117b427dab543f9b5f2aa750在受限环境出现Shell子进程无输出和fixture文件未生成，保留失败日志；添加显式spawn错误转抛后后台提升权限复跑通过。测试全部使用假Docker。
- 生效范围：本地脚本及测试，仅按独立Care项目名前缀阻断，不能宣称拦截任意自定义名称或直接Docker调用。未修改既有私有服务器备份、未删除任何备份。正式协调备份入口仍未完成，六项目标保持未完成；微信窗口未置顶。

### 2026-09-18 15:54:45 | Codex (GPT-6 Astra；Luna适配及测试；Terra只读复核) | 正式Care备份维护窗口
- 意图：复用私有试用已验证的停写顺序，让正式独立项目备份时先排空注销任务，结束后安全恢复原服务状态。
- 决策：新增deploy/scripts/care_backup_quiesce.py，基于原trial helper适配不可变显式配置：cboard-care项目、64位固定容器ID、项目对应timer/service和绝对restore hold路径。只对验证ID/labels/布尔Running/health的容器stop/start，不接受任意Compose命令。先停timer、等待worker退出、停API并再次inspect确认后才yield；结束后同ID恢复healthy才恢复timer。原API已停保持停；任何恢复检查遇hold阻止启动；停止失败且API不健康不恢复timer。
- 理由：停止命令成功不等于停写确认，容器名称也不能保证恢复的是同一实例。沿用现有contextmanager和systemd/Docker操作，不另建清理或备份引擎。未知状态和恢复失败须显式报告，不能返回成功收据。
- 证据：root实际读取最终受管codex-test-51576-c3365e8fa6e9425ea2e52897a5110fd0，9项通过，覆盖停写顺序、固定配置、原停机保持、hold中途出现、worker超时/未知、停止未生效、停止失败且不健康、timer恢复失败。此前54372-b6d0788a6a164df6a7a6de185742bdea的8项通过后因发现健康恢复分支缺口补测，不能只引用旧8项代替最终验证。
- 生效范围：本地可复用维护窗口模块，所有Docker/systemd为测试替身；未调用真实服务、未安装调度、未接入完整备份。手工清理任务和其他维护入口尚需统一维护锁；该helper不能单独证明所有写入被排除。媒体命名卷导出、密钥独立备份、容量/完整性模块接线及真实恢复仍是后续工作。没有修改原私有trial模块或服务器。六项目标未完成，窗口保持后台。

### 2026-09-18 16:00:42 | Codex (GPT-6 Astra) | Care备份与注销共享维护锁
- 意图：避免支持入口中的手工/定时注销与备份并发，补上只暂停systemd定时器无法排除手工任务的缺口。
- 决策：复用宿主flock，在docker-runtime新增项目级持久锁文件（同checkout的deploy/.care-maintenance.<project>.lock）。注销入口取得共享非阻塞锁，再次检查restore hold；backup-care.sh取得排他锁，全程持有到Python调用结束。锁文件拒绝符号链接和非普通文件，持久保留inode，不做解锁删文件。备份入口要求绝对环境/数据/密钥目录，按标签发现唯一完整容器ID，再交Python复核与备份；不启动容器，不静默sudo或切换Docker上下文。
- 理由：使用发行版锁工具而非自制协调服务；内层已有容器flock仍阻止重复注销批次，外层排他锁负责维护窗口。备份所需Python模块单独接入，不能以shell替身成功证明备份内容齐全。
- 证据：root读取受管59608-6f35b06c25944e16b4da5ae1e5057950，注销入口13项通过；71548-b9738f6ac7914484add85e34fb7ceaa5，备份shell4项通过，覆盖成功、维护繁忙、多容器与Python失败的顺序/退出码。测试使用假Docker/flock/Python，未实际验证Linux内核锁争用或复制媒体。
- 生效范围：本地支持入口及gitignore；同checkout/project内遵守入口的任务有效，不保护直接docker exec、任意Python调用或另一checkout。未安装到服务器，未操作真实备份。完整Python备份和真实恢复仍待完成；微信窗口未置顶。

### 2026-09-18 16:09:32 | Codex (GPT-6 Astra；Luna完整备份适配；Terra卷归属复核) | Care数据库媒体密钥备份接线
- 意图：让新独立Care部署生成可供后续隔离恢复验证的完整材料，而非只有Mongo单包。
- 决策：复用trial备份骨架、完整性和容量代码，新增backup_care.py及care_backup_integrity.py/care_backup_policy.py，接入backup-care.sh与维护窗口。复核完整API/Mongo ID及项目/服务标签，检查API媒体卷、Mongo数据卷的名称/标签/实际挂载；核对运行API的加密active/keyring/MONGO_URL与环境文件、CARE_MEDIA_ROOT固定路径，以及Mongo keyfile挂载来源。数据与密钥目录必须绝对、互不包含且无父级符号链接。停写窗口中流式dump、从已停API复制媒体、独立复制环境/keyfile，双清单校验并恢复服务后才发布收据。保留失败run及partial，不删除旧备份；收据先写partial并fsync，再硬链接发布，不覆盖既有收据。
- 理由：容器标签不能证明挂载数据归属，配置文件也可能已与运行实例的解密钥不同。复用已验证的工具与停写流程，保持成功收据和失败证据分开；完整性清单用于发现损坏，不是数字签名或真实恢复证明。
- 证据：Luna受管62100-0b50d573de414d2ea675bbf3f487772a共17项通过，root已读日志；root补充运行keyring/Mongo数据卷/keyfile不匹配拒绝与媒体复制失败保留/恢复测试，28588-48c9d70c68fa458d8f6fec0a1c06735f最终19项通过。此前shell入口4项与closure锁13项已记录；本次git diff --check通过。Python测试使用真实临时文件/manifest，Node配置读取、Docker/systemd与可用空间为替身；没有真实mongodump或容器文件复制。
- 生效范围：本地完整源码流程已接线，尚未实际构建/部署或恢复。媒体容量为停API前估算，未把最终dump体积和复制增长证明为严格硬上限；两个根分别检查其所在文件系统。现有服务器定时备份完全未改；真实Linux锁争用、stopped容器docker cp、密钥解密与数据库恢复仍需隔离验收。异地备份、独立最新撤权/注销状态恢复、外部告警及其他五项上线门槛仍未完成。全程后台，没有置顶微信窗口。

### 2026-09-18 16:14:38 | Codex (GPT-6 Astra；Terra隔离方案复核) | Linux锁与停止容器媒体复制真实探针
- 意图：将上一轮依赖替身的关键运行假设转为真实Linux/Docker证据。
- 决策：本地Docker引擎管道不存在，未启动桌面窗口；复用现有SSH在私有服务器创建唯一随机owner标签的临时容器/命名卷，使用已缓存固定API镜像并pull=never、network=none、只读根、无端口、无业务环境、cap_drop ALL、64MiB/32进程限制和显式sh入口。只写合成字符串，容器退出后docker cp复制。真实docker-runtime在临时checkout中检验共享锁并存、排他锁拒绝及释放后成功。清理前核对精确ID/owner，只删除本轮资源。
- 理由：现有API镜像默认启动业务程序，必须覆盖entrypoint；新卷root-owned所以仅合成helper用受限root写入。不能把Compose解析或fake flock通过当作Linux锁和停止容器复制已验证。
- 证据：受管46204-a62d4dbd94dd4946b44ea9c7e33c5242实际成功，root已读日志；真实探针run=43f88443d6694817b6b5d40f566fd593，real_shared_exclusive_lock、stopped_container_named_volume_copy、image_timeout_and_flock_present及owned_resources_cleaned全部true。媒体SHA256=53096b270bb467891900ea1cdb84a4735d02b5a4cfd2c82fb2072eb6ee709b1b。JSON证据care-backup-runtime-probe-43f88443d6694817b6b5d40f566fd593.json。本轮没有挂入任何现有业务数据或连接业务网络。
- 生效范围：真实运行原语与固定现有镜像验证，尚非最新镜像构建、完整backup-care流程或数据库/加密恢复。未重启/替换既有业务容器，未更改服务器定时任务。临时测试资源已清理。六项目标未完成，微信窗口未置顶。
- 新确认前提缺口：只读受管72256-3bb6298b76be49c19eb748426e562731与care-host-prerequisites-20260918.json显示宿主node=false，python3/flock/docker/bash=true。当前新脚本的宿主Node配置读取不能直接运行，需复用容器Node fallback；此检查没有安装软件。后续在接线验证前继续将完整备份验收标为未完成。

### 2026-09-18 16:20:27 | Codex (GPT-6 Astra；Luna配置读取适配) | 无宿主Node的真实容器读取验证
- 意图：解决真实私有服务器缺少宿主Node的配置读取前提，不安装额外宿主运行时或另造dotenv解析。
- 决策：新增readDeploymentEnvironment.js，复用现有parseEnv，显式选择字段并支持JSON/lines；错误固定文案、不打印完整环境。read-deployment-env.sh优先宿主Node，缺失时用缓存node:22.23.1-bookworm-slim或显式sha256本地镜像ID；raw image ID不冒充repo manifest digest。容器pull=never、network none、readonly、cap_drop ALL、no-new-privileges、受限内存/进程、显式Node entrypoint，root身份只为读取0600环境文件，source/env均只读挂载。
- 理由：容器镜像已具备Node，无需因备份在宿主安装另一套。只读合成探针能验证真实无Node分支，而fake Docker不能证明镜像引用、权限或入口正确。
- 证据：受管79720-197e1fbdd260476988a5e5a3dbc42e38已实际通过并读日志；真实run=fc9fd69a3b2840dfa5c353c8249fc502，noHostNode/selectedFieldsOnly/missingFieldRejected/temporaryDirectoryCleaned均true。使用固定缓存API镜像、临时source包和synthetic.env，不读取既有secret。JSON为care-environment-reader-probe-fc9fd69a3b2840dfa5c353c8249fc502.json。
- 生效范围：helper和真实隔离读取路径；新initialize-care、run-care-closure、backup-care及Python解析调用方尚未统一接线，不能宣称完整备份已摆脱宿主Node依赖。默认Node镜像缺失时会失败，不自动拉取。现有业务服务和定时任务未改，真实数据库/加密恢复、异地备份和全部上线标准仍未完成。微信窗口未置顶。
- 同轮定向回归补充：root已读取42560-6fada7c2397b4511ac0813815ad7496f日志，4项Node/隔离shell测试通过（字段选择、缺字段/重复字段拒绝、缓存容器隔离参数、非digest override拒绝）；git diff --check通过。测试和真实探针范围分别保留，不等同调用方已接线。

## 2026-09-18 16:31:22 | Codex (GPT-6 Astra) — 无宿主 Node 的运维入口接入
- 意图：让现有私有服务器能够执行正式 Care 配置读取和备份入口。
- 决策：Shell 初始化、注销任务与备份复用 read_deployment_value；Python 备份通过 Bash reader 获取严格字段白名单。无 Node 时使用现有缓存镜像，禁止拉取和网络，只读挂载，限制权限与资源。
- 理由：服务器没有宿主 Node；复用既有环境解析器，避免重复解析及把密钥写入日志。
- 证据：19 项 Python 回归通过（codex-test-70864-d3e2a5091a774da29478eb7f15bb02b9）；reader 4 项通过（codex-test-57452-ba2ad5703fc943bd885ef4183395125e）。真实隔离探针 codex-test-67092-9713f63c366340829acc2b23349daec3 通过，SHA256 4b7e83ed68b0dc61639c375ba015735f124eb5819ef41329c5122ed07346eb20：服务器无宿主 Node，Shell 与 Python 调用成功，缺失字段拒绝，只返回指定字段，临时资源清理成功。前两次探针因上传包漏带 docker-runtime.sh 失败，记录保留，补齐后验证通过。
- 生效范围：本地运维源码和真实服务器合成配置读取验证；未替换业务服务、未重启服务、未打开小程序窗口。Windows Shell 执行测试受 EPERM 限制，静态检查与真实 Linux reader 验证不能代表完整备份恢复验收；正式整包备份及解密恢复仍待完成。

## 2026-09-18 16:33:20 | Codex (GPT-6 Astra) — 备份完整性检查补漏
- 意图：确保完整恢复前检查覆盖全部媒体文件。
- 决策：复用现有 integrity inventory，仅在备份根目录排除正式清单与receipt；媒体子目录同名文件仍计算校验和，特殊文件拒绝。
- 理由：原实现按basename排除，会漏检嵌套的receipt.json/integrity.json。
- 证据：新增嵌套同名媒体篡改、根receipt后发布及媒体删除测试；连同备份和停服恢复测试22项通过，日志 codex-test-23024-9ccc1ea3a4894b40a8e84022aceb9018，receipt SHA256 a747895276a97be007a216221ccc62392a0fdbcb777038541687e54dab9a33db。
- 生效范围：正式Care本地源码与合成回归；未修改历史备份清单、私有服务器旧脚本或业务数据。此结果不证明完整数据库与媒体恢复已完成。

## 2026-09-18 16:37:36 | Codex (GPT-6 Astra，Luna 实施) — 运维入口联合回归
- 意图：阻止 Care 通过旧脚本只恢复数据库，并确保配置读取接入不破坏已有操作路径。
- 决策：restore-mongo.sh 在 Docker 查询和安全标记写入前拒绝 cboard-care-*；backup-care.sh 明确要求直接 Docker 权限，与 Python 调用保持一致。测试夹具使用 Git Bash 绝对路径并隐藏窗口；编排用例限时30秒。
- 理由：Care 恢复必须同时处理媒体、密钥及授权安全核对；sudo预检成功不代表Python直接Docker可用。Windows路径与默认2秒测试上限导致初次回归误阻，保留失败记录后修正夹具。
- 证据：四套Shell联合49项通过，codex-test-66640-554bd1ae5b454338bb0fac3ff5a8649d，SHA256 26440a34c5ebcdeb7119290c4940412b103158c6e4531be2374dd3a3b01a2622。涵盖初始化、注销任务、备份和旧恢复/部署守卫；Care拒绝用例证明零Docker调用、零hold写入。先前失败45328-d736a4600d334aa096d684e4bb20fb3d与66004-1d2d75feafc34dcd8cfd72ab806e35be保留。
- 生效范围：本地源码和Shell替身测试，未部署/操作线上资源；完整Care恢复实现与真实演练仍未完成，旧入口拒绝不是完成替代品。

## 2026-09-18 16:38:55 | Codex (GPT-6 Astra，Terra 实施) — 恢复镜像可追溯性
- 意图：让正式备份可以在不依赖原运行服务的情况下选择正确恢复镜像。
- 决策：复用已校验身份的Docker inspect结果，API/Mongo Image必须为严格sha256 digest，在创建备份目录和停止服务前拒绝缺失或非法值；成功receipt增加apiImageId/mongoImageId。
- 理由：旧receipt仅保存container ID，容器删除后不足以确定解密代码和Mongo版本；现有隔离恢复骨架可复用，但不能继续硬编码试验服务身份。
- 证据：备份定向11项通过，codex-test-75280-cbca90410ea844bcbe68c8e6a2cb2e80，SHA256 5a40e06945784d2ced350c378332b339cc615359a3d2d2b8c3e58e7b120bc460；包括成功receipt与非法digest在停服/创建目录前拒绝。另补sudo-only权限合同，5项Shell通过 codex-test-70236-89bd9309490d4ca28c60a68297eb2e1a，SHA256 72e34c71d8f4c061975abc65fa795fd0643b6fcc11071a5942fb69298ef0921f。
- 生效范围：本地正式Care备份源码；未修改旧备份或服务器。下一步复用restore_scheduled_trial的隔离Mongo、careCrypto媒体解密和owner清理流程，适配8位run、deployment.env、动态数据库及流式archive。成功演练也不能解除真实恢复的权限安全hold。
