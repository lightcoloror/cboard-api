# 火山引擎大模型录音识别服务端接入决策

## 意图

把原图语家规划中的豆包语音识别能力作为可选服务端能力接入 CBoard 技术底座，同时保持 Web、微信小程序和后端分离。供应商密钥只保存在 `cboard-api`，识别结果必须先回到可编辑文字，不能绕过人工确认直接触发分词或图片匹配。

## 决策

1. 继续复用认证路由 `POST /gpt/communication/dialect-asr`、一次性录音同意、3 MiB/60 秒上限、增强服务限流和人工复核流程，不新增客户端接口。
2. 在现有中性 ASR provider factory 中增加可选的 `volcengine` adapter，调用火山引擎官方“大模型录音文件极速版识别 API”。腾讯云 `16k_yue` provider 保持兼容。
3. 新控制台优先使用服务端 `VOLCENGINE_ASR_API_KEY`；旧账号可使用完整的 App-Key 与 Access-Key。客户端、健康接口、日志和沟通记录均不得返回密钥。
4. 使用 Node 22 原生 `fetch`、`AbortSignal.timeout` 和已有音频校验，不引入 Python、WebSocket、ffmpeg、sidecar 或新的 npm 依赖。
5. 火山引擎路径只接受官方支持且当前客户端可稳定生成的 MP3、WAV 与 OGG Opus。识别原文返回后仍由照护者修改、确认和手动生成图片序列。

## 理由

- 此前暂缓豆包 ASR，是因为当时审阅到的成熟方案主要依赖 Python、WebSocket 与音频转换；把第二运行时塞进 Node API 会扩大部署、隐私和恢复成本。
- 火山引擎当前官方极速识别接口已经变为一次 HTTP POST，Node 服务可以直接复用现有路由、校验、认证、限流和错误边界，旧阻碍已经消失。
- 保留中性 provider factory 可让部署方在腾讯云和火山引擎之间选择，不需要复制 Web/微信业务链，也不把供应商语义带进患者 UI。
- ASR 可能误识别。把“录音识别”“文字规范化”“分词与图片匹配”保持为三个独立步骤，才能保证照护者最终修正权和离线沟通底线。

## 证据

- 火山引擎官方大模型录音文件极速版识别 API：<https://www.volcengine.com/docs/6561/1631584?lang=zh>
- 官方契约为 `POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash`，资源 ID 为 `volc.bigasr.auc_turbo`，成功状态码为 `20000000`。
- `communicationVolcengineAsrProvider.unit.js` 覆盖新旧凭据、请求头与请求体、MP3、格式拒绝、静音、无效音频、限流、过载、HTTP 5xx、超时、畸形/超大响应和超长时长。
- cboard-api 无数据库单元测试为 `261 passing`；生产部署模板、语法、Prettier 和差分检查通过。
- CBoard Web 为 `190 suites / 1258 tests / 72 snapshots`，生产构建成功。
- 微信小程序为 `65 files / 285 tests`，类型、ESLint、依赖边界、质量门和生产构建通过；主包未压缩 `1,249,564 B`，低于 1.5 MiB 建议线。

## 生效范围

- 只影响部署方显式选择 `COMMUNICATION_DIALECT_ASR_PROVIDER=volcengine` 后的认证服务端录音识别。
- Web 与微信继续使用既有 ASR 路由和可编辑文字流程；腾讯云 provider、WechatSI、手工输入、本地分词、matcher、图片、历史和默认板不变。
- 服务端不持久化录音，不把录音加入沟通历史；上游错误正文和密钥不返回客户端。
- 本轮没有真实火山引擎凭据联网，尚未完成服务开通、配额/费用、真实粤语质量、公开 HTTPS、微信合法域名、弱网和物理手机验收，因此不能宣称生产识别质量已经通过。
- 本轮没有预览、上传、发布、部署、提交或推送；没有打开、激活、聚焦、抬升或置顶任何窗口。

## 变更记录

- 2026-07-22 14:31:35 | Codex（GPT-5.6）| 接入火山引擎大模型极速录音识别可选 provider，并以官方 HTTP API 新证据取代旧的 Python/WebSocket 暂缓边界。

## 2026-07-29 认证 HTTP 与 Mongo 组合验收

### 意图

把已有 provider 单元测试推进到普通用户真实登录、Swagger multipart 音频、服务端密钥、火山协议响应与私密客户端结果的完整工程链，避免用局部 mock 推断生产路由安全性。

### 决策

新增显式环境门控的 `communicationVolcengineAsrHttp.mongo.integration.js` 和 `verify:communication-volcengine-asr-http-mongo`。测试继续调用生产路由、认证中间件、Mongo 用户模型、音频校验和 provider，只把收费公网端点替换为 loopback 确定性 HTTP 服务。成功转写响应补齐 `Cache-Control: no-store, private` 与 `X-Content-Type-Options: nosniff`。参考成熟实现后，将每次请求 UUID 同时作为非敏感 `user.uid`，API key 只保留在认证头，不再重复进入请求体。

### 理由

语音转写包含患者或照护者的敏感表达，不能由浏览器、WebView 或中间缓存保存。匿名请求必须在触达供应商前失败，供应商密钥只能从服务端环境进入上游请求。loopback 服务保留完整 HTTP 请求和响应语义，同时不发送真实录音、不消耗额度，也不需要自研第二套 ASR。

### 证据

- MIT `doubao-speech` 固定提交 `949f2de8ce6dcca36e8d3f4ff55c30ffb5df30db` 已在本地执行 `uv sync --frozen --dev`、Ruff、mypy 和非集成测试；结果为 `123 passed / 2 deselected`，覆盖率 `91.46%`。该项目用于学习成熟 Volcengine 认证、错误和测试结构，不机械替换当前官方 Flash HTTP adapter。
- cboard-api 认证 HTTP/Mongo 组合门 `2/2`：匿名 multipart 返回 403 且 provider 调用数保持 0；普通用户登录后返回 200，服务端只在认证头发送 `X-Api-Key`，请求体使用同一 UUID 作为 `user.uid` 并明确断言不含密钥；资源 ID、序列号、Base64 音频和客户端非敏感结果均符合契约。
- ASR/provider/controller 聚焦回归 `30/30`，API 全量单元回归 `376/376`；Prettier 与 `git diff --check` 通过。

### 生效范围

只影响认证 `POST /gpt/communication/dialect-asr` 的成功响应缓存策略、可选集成测试和验证命令；Web/微信的录音、人工修改、分词、matcher、腾讯云 provider 与 WechatSI 不变。没有真实火山凭据、收费请求、患者音频、公网部署、微信预览、真机或粤语质量验收，因此仍不能宣称生产识别质量通过。

- 2026-07-29 08:19:24 | Codex（GPT-5.6）| 完成认证 HTTP/Mongo 组合验收并补齐敏感转写结果的私密缓存边界。
