# 图语家 CBoard API 当前生产就绪缺口

## 状态

- 审计时间：2026-07-22 21:49:04
- 执行工具 / 模型：Codex（GPT-5）
- 审计对象：当前本机 `cboard-api` 工作树和生产部署模板
- 结论：模板有效，当前生产配置和运行实例未就绪

## 意图

区分“生产部署代码与模板已经写好”和“当前机器已经具备可供微信真机访问的生产 API”，避免用构建、单元测试或示例配置通过冒充真实 Mongo、Blob、短信、AI 和公网服务已可用。

## 决策

1. 运行现有 `scripts/checkProductionDeployment.js --example` 校验模板，不新建第二套部署检查器。
2. 对真实默认路径运行同一检查器，只读取缺失项，不自动生成 `.env.production`、密钥、证书或云资源。
3. 通过 HTTP 只读探测 `http://127.0.0.1:10010/health`，不启动 Docker、不连接真实支付、不发送短信或模型请求。
4. 当前保持小程序的准确降级：离线核心继续可用，云同步、私有图库、短信和增强服务在 API 未配置时不得显示为可用。

## 理由

- 生产模板包含 Caddy HTTPS、非 root API、内部 Mongo、健康检查、速率限制和 Token 月额度等成熟基础，应该继续复用。
- 真实部署需要用户或运维方持有域名、Mongo/Azure/腾讯云凭据和独立随机密钥；AI 不能猜测、生成后公开或写入版本控制。
- 微信合法域名和物理手机只能访问真实 HTTPS 服务，本地模板通过不能替代这一步。

## 证据

- `node scripts/checkProductionDeployment.js --example`：`Production deployment template is valid.`
- 真实默认检查：缺少 `deploy/.env.production`，因此 API 域名、ACME 联系邮箱、Mongo 账号/连接、会话/JWT 密钥、Azure Storage、私有图库容器、腾讯云短信和增强额度配置均未提供。
- `http://127.0.0.1:10010/health`：3 秒内无响应，当前没有可验收的本地 API 健康实例。
- 代码质量证据独立有效：订阅聚焦 `17 passing`、cboard-api 无数据库单元全量 `298 passing`、Swagger v2 校验通过；这些结果不被升级为生产运行证据。

## 生效范围

- 已就绪：部署文件、示例配置、静态校验、应用代码和无数据库回归。
- 未就绪：真实 `.env.production`、公网域名与证书、Mongo、Azure Blob、腾讯云短信、可选 AI/ASR/TTS 凭据、微信 request 合法域名、真实健康检查和多设备验收。
- 不需要重复开发：患者表达、照护接收、分词、图文匹配、朗读、个性化图卡和离线历史不依赖这些外部配置。
- 操作边界：本轮未创建密钥、启动 Docker、发送短信、调用付费供应商、部署、预览、上传、发布、提交或推送；没有打开、激活、聚焦、抬升或置顶任何窗口。

## 更新记录

### 2026-07-26 10:14:24 | Codex（GPT-5.6）

- **意图：** 消除 `/user/oauth/proxy` 可被外部请求直接调用的边界缺口，同时继续复用 CBoard 官方构建服务鉴权契约。
- **决策：** 机械适配 cboard-api 上游 `53ad78e40e3e0d5b4adb1c669514b20d69cd6e7f`，要求 `Authorization: Bearer <INTERNAL_API_KEY>`，使用等长 Buffer 和 `crypto.timingSafeEqual` 比较；缺少服务端密钥或请求令牌不正确时在数据库查询前返回 `401`。继续复用 `api/helpers/cbuilder.js` 已有 Bearer 请求，不新增第二套 token、endpoint 或依赖。
- **理由：** 该端点用于受信 CBuilder 内部交换 OAuth 登录结果，不应成为公网匿名代理。官方修复与现有配置字段完全兼容，直接复用比自行设计鉴权协议更小、更安全；密钥未配置时失败关闭也比无鉴权降级更可靠。
- **证据：** 新单元测试证明缺失、空值、Basic 和错误 Bearer 都返回 `401` 且不会查询用户，正确 Bearer 才进入既有登录流程。`test/controllers/**/*.unit.js` 全量 `357 passing`，Node 语法、Prettier 和目标 `git diff --check` 均通过。旧式 controllers 集成入口仍因本机未提供 Mongo、SMTP 和 IPInfo 凭据而不可作为本轮门禁，未将其外部环境失败归因于此补丁。
- **生效范围：** cboard-api 的 `/user/oauth/proxy` 和 CBuilder 内部调用；不改变普通邮箱/手机号/第三方登录、微信离线核心、患者表达或接收理解。生产环境必须给 API 与 CBuilder 配置相同 `INTERNAL_API_KEY`，否则该内部交换按设计返回 `401`；本轮没有生成、记录或部署任何真实密钥，也未提交或推送。

### 2026-07-22 21:49:04 | Codex（GPT-5）

- 新建当前生产就绪缺口清单，记录模板验证、真实配置缺失和健康端点无响应的证据。
