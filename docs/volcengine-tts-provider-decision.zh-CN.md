# 豆包 Seed TTS 服务端接入与语音识别边界决策

## 意图

恢复原图语家路线中“豆包语音能力由后端调用”的可选方案，同时保留 CBoard 已经跑通的 Web、微信小程序和 API 契约。供应商密钥只能留在 `cboard-api`，不能进入浏览器包、微信小程序包、日志或患者沟通记录。

## 决策

1. 在现有 `POST /gpt/communication/speech` 路由后增加可选的豆包 Seed TTS provider，不新增客户端 endpoint。
2. provider 使用火山引擎当前 V3 SSE 接口；部署方显式设置 `AI_TTS_PROVIDER=volcengine` 和 `VOLCENGINE_TTS_API_KEY` 后才启用。
3. 复用 OpenClaw 的 MIT 许可 TypeScript provider 所验证的 V3 请求、SSE 分帧和音频拼接思路，但按 CBoard API 的错误、限额、缓存、健康检查和测试边界重新实现，不引入 OpenClaw 运行时或新的 npm 依赖。
4. 保留原有 OpenAI-compatible TTS provider。微信小程序仍先用 WechatSI，失败后且用户已登录时才调用服务端付费回退。
5. 本轮不声称完成豆包 ASR。粤语和普通话的服务端语音识别继续使用已经接入的腾讯云 SentenceRecognition；客户端可用的原生识别路径保持不变。

## 理由

- 火山引擎已经公开当前 V3 HTTP/SSE TTS 协议，Node 服务可以直接用平台自带的 `fetch` 和 `AbortSignal.timeout` 完成，不需要第二套 SDK。
- OpenClaw 的活跃 TypeScript 实现提供了更接近当前 Node 工程的可复用证据，比从 Python 示例翻译协议更稳妥。
- 当前可找到的豆包 ASR 成熟封装主要是 Python 生态；完整接入还会带来 WebSocket、音频格式转换和可能的 `ffmpeg`/sidecar 运维成本。`cboard-api` 目前是 Node 22 单服务，仓促加入第二运行时会扩大部署、隐私和故障面。
- 现有客户端都依赖中性的 speech/ASR port，因此替换服务商不应改变患者表达、分词、图片匹配或接收端 UI。

## 证据

- 火山引擎官方语音合成文档：<https://www.volcengine.com/docs/6561/79817?lang=zh>
- 火山引擎 V3 语音合成接口文档：<https://www.volcengine.com/docs/6561/2228192?lang=zh>
- 火山引擎官方语音识别文档：<https://www.volcengine.com/docs/6561/1354871?lang=zh>
- 火山引擎官方 AI App Lab 使用 Python Arkitect 的实时语音示例：<https://github.com/volcengine/ai-app-lab/blob/main/demohouse/live_voice_call/README.md>
- OpenClaw Volcengine TTS TypeScript 实现：<https://github.com/openclaw/openclaw/blob/main/extensions/volcengine/tts.ts>
- OpenClaw MIT 许可证：<https://github.com/openclaw/openclaw/blob/main/LICENSE>
- 新增 provider 单元与 controller 集成回归后，API 无数据库单元测试为 `241 passing`；生产部署模板校验通过。
- CBoard Web 现有 speech port 定向回归为 `1 suite / 14 tests`；微信小程序现有 communication AI/speech port 定向回归为 `2 files / 14 tests`。
- provider 覆盖未配置、voice allowlist、V3 headers/body、多 SSE 帧 MP3 拼接、异常帧、超时、限流和响应体上限；健康接口只报告 provider/model/voice，不泄露密钥。

## 生效范围

- 只影响部署方显式启用后的认证服务端 TTS 回退。
- Web 与微信小程序继续调用既有 `/gpt/communication/speech`，无需携带供应商配置。
- 不改变 WechatSI、浏览器/原生 TTS、患者文字、分词、matcher、图片搜索、历史同步或默认板。
- 不把文字、生成音频、供应商密钥或上游错误正文持久化。
- 豆包 ASR、真实供应商凭据联网、公开 HTTPS 部署、微信合法域名、真机弱网和费用验收仍未完成，不能据此宣称豆包语音全链已经上线。
- 本轮没有预览、上传、发布、部署、提交或推送，也没有打开、激活、聚焦、抬升或置顶任何窗口。

## 变更记录

- 2026-07-22 13:04:04 | Codex（GPT-5.6）| 新增豆包 Seed TTS 可选 provider，记录开源复用来源、验证证据与 ASR 暂不接入边界。

## 补充决策：ASR 暂缓边界已被新官方接口取代

- **意图：** 保留原决策形成时的依据，同时让后续维护者一眼看出豆包 ASR 状态已经变化。
- **决策：** 不删除上文“本轮不声称完成豆包 ASR”的历史记录；从 2026-07-22 14:31:35 起，以 `volcengine-asr-provider-decision.zh-CN.md` 为当前 ASR 决策，现已通过既有中性路由增加可选火山引擎 provider。
- **理由：** 上文判断基于当时可审阅的 Python/WebSocket/ffmpeg 方案；火山引擎随后公开了可由 Node 22 原生 `fetch` 调用的一次 HTTP 极速识别 API，原部署阻碍不再成立。
- **证据：** 官方文档 <https://www.volcengine.com/docs/6561/1631584?lang=zh>；cboard-api `261 passing`，CBoard Web `190 suites / 1258 tests / 72 snapshots`，微信 `65 files / 285 tests`，两端生产构建通过。
- **生效范围：** 只修正豆包 ASR 的工程接入状态；TTS provider、腾讯云 ASR、人工复核、离线主链和真实凭据/真机待验收边界均保持不变。
- **记录：** 2026-07-22 14:31:35 | Codex（GPT-5.6）| 追加决策演进说明，不覆盖旧证据。

## 2026-07-29 02:39:11 | 真实认证 HTTP 补充验证

- **意图：** 把豆包 TTS 从 provider 单元测试推进到普通用户 Bearer、Swagger、原生 HTTP、SSE 拼接和私有 MP3 响应的组合链。
- **决策：** 固定并运行 OpenClaw 当前提交 `642befa179d377395c1bb927f4bb562a29af9d67`，新增显式隔离 Mongo + 本地确定性 SSE provider 的 `verify:communication-volcengine-tts-http-mongo`；不把 OpenClaw 整包引入运行时，也不把中国区端点机械替换为其当前 BytePlus 国际端点。
- **理由：** OpenClaw 当前实现仍能验证 Seed Speech 请求、分帧和音频拼接，但其默认服务区域已经演进；中国区已有代码必须由自身契约单独验收。组合测试可发现认证和响应边界，又不需要真实密钥、费用或患者文本。
- **证据：** OpenClaw 固定源码经 lockfile 供应链检查后，Volcengine `tts/index` 非 live 测试 `22/22`；当前 Node 低于上游 engine 下限，首次官方 pnpm 入口被 preinstall 拒绝，直接运行同一 Vitest 在沙箱外通过。cboard-api 组合门 `2/2`：匿名 403 且 provider 0 次，普通用户 200，收到精确 MP3、`private, no-store` 和 `nosniff`；provider 观察到 API key、resource、request UUID、voice、rate 与 SSE 完成帧。API 单元 `376/376`、Prettier 通过。
- **生效范围：** cboard-api 可选豆包 TTS 认证 HTTP 工程证据和测试入口；Web/微信、WechatSI、ASR、语音文字人工复核与生产端点不变。真实火山引擎凭据、服务开通、音色质量、费用、延迟、公网 HTTPS、合法域名和真机仍待外部验收；未提交、推送、部署、预览、上传、发布或操作窗口。
