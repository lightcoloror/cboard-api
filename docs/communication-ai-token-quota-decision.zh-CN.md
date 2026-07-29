# 通信增强 AI Token 月额度决策

## 状态

- 决策状态：已生效
- 最后更新：2026-07-22 13:41:56
- 执行工具 / 模型：Codex（GPT-5.6）
- 相关工程：`cboard-api`、CBoard Web、图语家微信小程序

## 意图

在变动 161 已建立“服务商实际 Token 事实账本”的基础上，补齐请求发生前的按用户月度 Token 额度保护。目标是防止单个账号或故障客户端无上限消耗模型容量，同时保证额度耗尽、Mongo 暂时不可用或服务商失败时，患者仍可使用默认板、本地分词、本地匹配、人工修正、朗读和接收确认。

## 决策

1. 直接复用项目已安装的 ISC 许可 `rate-limiter-flexible@11.2.0` 及其 `RateLimiterMongo`，不新增数据库、队列、Python proxy、tokenizer 或 npm 依赖。
2. 生产环境默认开启，默认每个认证用户每个 UTC 自然月 `1,000,000` Token；开发环境默认关闭。额度、文字预留和图片预留分别由 `COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA`、`COMMUNICATION_AI_TEXT_TOKEN_RESERVATION` 和 `COMMUNICATION_AI_IMAGE_TOKEN_RESERVATION` 配置并执行上下界校验。
3. 只保护六条真正调用 Chat Completions 的操作：旧短语编辑、候选句生成、文字重分词、粤语文字归一化、图片 OCR 和图卡元数据建议。文字请求先原子预留 `4,096` Token，图片请求先原子预留 `32,768` Token。
4. 服务商返回 usage 后，以其 `total_tokens` 或同一响应的输入/输出 Token 和结算：实际值小于预留时原子退款，大于预留时原子补扣。服务商没有回报 usage 时不估算，保留完整保守预留并由既有事实账本记录未回报请求。
5. 请求在模型结算前失败、解析前退出或连接关闭时释放完整预留；同一响应的 `finish` 与 `close` 通过请求级串行状态机保证只结算或释放一次。
6. 额度键只保存 `UTC month + SHA-256(userId)`，不保存患者正文、提示词、图卡、图片、音频、手机号、邮箱或供应商密钥。当前月状态由既有认证 `GET /gpt/communication/usage` 一并返回；Web 与微信复用现有增强状态区展示剩余量。
7. 超额返回有界 `429 COMMUNICATION_AI_TOKEN_QUOTA_EXCEEDED`，存储不可用返回有界 `503`；双端统一回退本地规则，不回显 Mongo 或服务商内部错误。
8. TTS、粤语音频 ASR、去背景、WechatSI、公共图符搜索及全部本地沟通能力继续使用原有保护或本地路径，不被 Token 额度错误计费。

## 理由

- [rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible) 已在 cboard-api 中用于 Mongo 原子点数保护，并提供 `consume`、`reward`、`penalty`、`get` 和 `delete`，足以表达预留、退款、补扣、查询和删除；复用它比重造计数器更小、更可维护。
- [OpenMeter Entitlements](https://openmeter.io/docs/billing/entitlements/overview) 与 [Grants](https://openmeter.io/docs/billing/entitlements/grant) 已提供月度额度、补充额度和实时执行模型，未来出现付费套餐、充值、结转、组织账户或账单时应优先评估接入，而不是继续扩张当前轻量计数器。
- [LiteLLM](https://docs.litellm.ai/) 提供代理级预算管理，但需要 Python/Proxy 运行边界；当前 Node API 已有成熟 provider adapter，直接引入会复制认证、部署、观测和故障恢复链。
- 请求前必须先有保守预留，否则并发请求可以在事后记账前同时穿透额度；服务商回报后再结算，可以继续保留变动 161 的真实用量事实而不是长期依赖估算。
- 商业计费需要货币、价格版本、订单、支付、退款、发票、风控和对账。本轮没有这些前提，因此只称“使用额度”，不称“收费套餐”或“账单”。

## 证据

- cboard-api Token 额度聚焦回归 `40 passing`，全部无数据库单元回归 `253 passing`，生产部署模板校验通过。
- 单元测试覆盖生产默认值与配置边界、六个操作映射、非 AI 服务排除、自然月和哈希键、预留、服务商退款、服务商缺失 usage、超预留补扣、失败释放、状态读取、账号删除、并发结束钩子和有界拒绝。
- CBoard Web 全量 `190 suites / 1,257 tests / 72 snapshots` 和 production build 通过；旧服务器缺少 `tokenQuota` 时继续兼容，新错误码安全回退本地月额度提示。
- 微信小程序全量 `65 files / 284 tests`、TypeScript、ESLint、`186 app files / 29 CBoard core files` 边界和 production build 通过。质量门真实拦截一次管理页可选链，改为旧基础库兼容判断后通过。
- 微信未压缩包体：main `1,249,564 B`、caregiver `560,270 B`、emergency `91,589 B`、management `496,229 B`、backup `589,738 B`、OCR `62,279 B`，全部低于 1.5 MiB 建议线；未新增插件、图片、音频或运行依赖。

## 生效范围

- 生效：六类 Chat Completions 操作的请求前预留、服务商 usage 结算、失败释放、按用户 UTC 月查询、当前月账号删除清理、生产配置门和双端状态展示/本地降级。
- 不变：患者表达、照护接收、人工改文字与分词、图文匹配、默认板、历史、语音、TTS、ASR、去背景、公共图符和私有图库协议。
- 明确限制：如果单次服务商实际 usage 高于保守预留，该次请求可能形成一次有界超额；系统会补扣真实值并阻止后续请求，但不声称对未知服务商 tokenization 做到数学上的零超额。
- 未完成：价格、套餐、充值、支付、退款、发票、管理员账单、供应商账单自动对账、OpenMeter entitlement、组织共享额度和数据保留审批。
- 待验收：真实生产 Mongo 并发、真实 OpenAI/Azure 兼容 usage、公网 HTTPS、微信合法域名、物理手机状态展示与额度耗尽恢复。
- 操作边界：本轮没有预览、上传、发布、部署、提交或推送；全程只使用后台 shell、补丁、测试、构建与文档接口，没有打开、激活、聚焦、抬升或置顶微信开发者工具或任何应用窗口。

## 更新记录

### 2026-07-29 01:33:49 | Codex（GPT-5.6）

- **意图：** 把 Token 额度从 limiter/Mongo 局部验证推进到“真实登录 HTTP 请求 → 请求前预留 → OpenAI-compatible 响应 → Mongo 用量账本 → 本人额度查询”的完整链路。
- **决策：** 固定并运行 `openai-node v4.104.0` 官方源码及其官方 Prism 测试入口；新增显式 HTTP + 隔离 Mongo + 本地假 provider 集成门。联调发现 usage 路由把 `x-security-scopes` 误写为两个 `admin` 后，只将首个角色修复为 `user`，继续保留 `admin`，不改变控制器按 `req.user.id` 查询本人数据的设计。
- **理由：** 单元测试中的路由 fixture 不执行真实 Bearer 角色校验，无法发现普通用户 403；假 provider 可以确定重试次数和 usage，又不会发送患者内容或产生真实费用。复用现有 Swagger、OpenAI SDK、Nock、Supertest、Mongo 和配额服务比新增测试服务器或第二套协议更小。
- **证据：** 修复前，普通 `user` 成功生成候选句后读取 `/gpt/communication/usage` 得到 403；修复后真实链路依次结算 25 token、provider 两次 500 后释放 40-token 预留、再结算 60 token，并在 85/100 时让下一次 40-token 请求于 provider 前返回 429，最终仍为 85。官方 OpenAI Node harness `11/11`、API 全量单元 `376/376`、底层真实 Mongo 配额 `1/1`、HTTP 真实链 `1/1`、Prettier 全通过。
- **生效范围：** 认证普通用户和管理员读取各自当前 UTC 月 AI 用量与额度的权限、可选本地 HTTP/Mongo 验收命令及 issue #1 工程证据；不改变额度数值、provider 配置、Web/微信 UI、患者本地沟通链或任何生产部署。本轮未使用 Computer Use，未打开或置顶微信开发者工具，未预览、上传、发布、部署、提交或推送。

### 2026-07-29 01:14:05 | Codex（GPT-5.6）

- **意图：** 用真实 Mongo 并发验证请求前预留，而不是继续依赖只返回预设结果的 limiter mock。
- **决策：** 固定并运行 `rate-limiter-flexible v11.2.0` 官方源码；新增显式 Mongo 集成门。确认上游 `consume()` 超额时会先原子递增再 reject 后，复用同一库的 `reward()` 在返回 429 前退回本次拒绝预留；退款失败继续以 503 失败关闭。
- **理由：** 被拒绝的请求没有调用供应商，不应永久占用 Token；原子退款既保持并发正确性，也不需要新增数据库、锁、队列或计数器。
- **证据：** 修复前真实 Mongo 中三个并发 40-token 请求虽只接受两个，状态却为 `120 consumed`；修复后为 `80`，并完成 usage 结算、失败释放、有界超额阻断及账号删除。上游 Mongo adapter `32/32`、本地配额单元 `13/13`、API 全量 `376 passing`、真实 Mongo 集成 `1/1`、Prettier 全通过。
- **生效范围：** cboard-api 六类 Chat Completions 操作的月度配额拒绝路径及可选集成门；CBoard Web 与微信沿用原 429/503 本地降级，无协议或 UI 变更。真实 AI provider、生产 Mongo、公网 HTTPS、价格和支付仍待外部验收。

### 2026-07-22 13:41:56 | Codex（GPT-5.6）

- 新建决策文档，记录 Token 月额度的复用依据、预留与结算语义、隐私边界、跨端行为、商业计费边界和真实验收缺口。
