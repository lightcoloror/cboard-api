# 图语家 AI 分词受控接入与验收

更新：2026-10-16（Asia/Shanghai）。执行工具：Codex；实际模型版本未独立核实。

本批是本地候选版本，未修改真实配置、生产路由、资费或线上开关。自动验收使用合成账号、合成额度和模拟供应商响应，不代表当前供应商模型可用或手机验收通过。

## 复用与范围

继续使用 `/gpt/communication/resegment`、现有 OpenAI-compatible SDK、resegmentationContract v2、careAiMetering、careBudget 及两端请求拦截器。模型路由实验参数来自既有 VKP `model_runtime_client.py`，固定 tokens schema 来自 `outputs/tuyujia-semantic-repair-20261013/plan.json`。没有另建模型路由或计费系统。

## 服务端参数

`AI_RESEGMENT_REQUEST_OPTIONS` 是可选的 JSON 字符串，仅供服务端分词调用使用。留空保持现有参数。它不会读取客户端传入的模型、URL、headers 或 provider options，不修改 `AI_MODEL`、`AI_BASE_URL` 或凭据。

| 字段 | 接受值与转换 |
| --- | --- |
| `response_format` | 字符串 `text`、`json_object`、`json_schema`；后者使用固定 tokens schema |
| `max_tokens` | 128–8192 的整数 |
| `enable_thinking` | 布尔值；适配支持此字段的供应商 |
| `thinking_mode` | `enabled` 或 `disabled`；转换为 `thinking: {type: ...}`；不得与 `enable_thinking` 同时填写 |
| `thinking_budget` | 128–8192 的整数；本项目的保守上限 |
| `reasoning_effort` | low、medium、high、max；是否支持及实际含义由所选模型决定 |

关闭思考时不接受 `thinking_budget` 或 `reasoning_effort`。未知字段、错误类型、非法 JSON 或冲突配置返回 `AI_RESEGMENT_CONFIGURATION_INVALID`（503），在调用供应商之前拒绝；响应不回显配置。

例如，**仅在确认所选模型支持后**，可配置：

```dotenv
AI_RESEGMENT_REQUEST_OPTIONS={"enable_thinking":false,"max_tokens":2048,"response_format":"json_object"}
```

SDK 的 JavaScript 调用使用原生顶层参数；没有照搬 Python SDK 的 `extra_body` 包装。`json_schema` 约束输出结构，不替代完整还原原文、否定/顺序/重复和 Unicode 跨度校验。分词 SDK 请求禁用隐式重试；其他 AI 功能维持原行为。

参数依据：[硅基流动官方 Chat Completions 文档](https://docs.siliconflow.cn/docs/api/chat-completions-post)。支持情况随模型变化，不能把历史实验中 `reasoning_effort=low` 当作当前所有模型的低成本保证。本批验证真实 SDK 发出的 HTTP 结构，未重新调用付费供应商。

## 客户端受控入口

受限 Web 构建（`REACT_APP_TUYUJIA_CLOUD_TRIAL=true`）默认关闭在线文字 AI。仅显式设置 `REACT_APP_CARE_AI_TRIAL=true` 时显示可用的既有额度选择，并按账号、患者档案、额度来源判断操作状态。未登录、未选择档案/额度或档案锁定都有提示。本地分词和图片匹配仍可使用。

这个开关只控制文字 AI 入口，不开启 OCR、图片生成或公开注册。非受限构建保持旧行为。前端检查只用于交互，真实授权与余额仍必须由服务端核验。

请求继续经原有拦截器携带 `X-Care-Profile-Id`、`X-Care-Funding-Id` 和 `Idempotency-Key`。小程序只补真实 Taro 调用链测试，不改变发行配置的 `aiFeatures` 值。

## 消费结算

供应商已返回明确 usage，但候选未通过原文保真校验时，按现有计价策略结算实际已知消费，不能无限挂起预留。真实零用量遵循原有 fixedUnits 下限，本批没有修改价格或赠送规则。

供应商超时、断开或没有可靠用量的失败请求保留预留，等待对账；确定没有执行的请求释放。成功但无 usage 仍按现有固定计价策略处理。缺失或伪造的零值不能被当作可靠用量报告。

**仍待实现：**用户对结果未知的请求再次点击时，客户端尚未持久复用同一个请求 ID；因此不能声称跨点击、重启后的重试不会产生第二次模型调用。一次点击内的重复操作防护与 SDK 无隐式重试已验证。

## 变更来由

| 变动 | 意图 | 决策与理由 | 证据 | 生效范围 |
| --- | --- | --- | --- | --- |
| 参数白名单适配 | 使实验验证过的格式参数进入实际 API | 改造现有 SDK 调用；拒绝客户端覆盖，避免另起路由 | provider 单测及真实 Swagger/SDK HTTP 夹具 | 分词接口 |
| 禁止隐式重试 | 一次点击的供应商调用可解释 | 仅该 SDK 调用 `maxRetries:0`，未知结果进入对账 | 上游 500、超时调用次数断言 | 分词接口 |
| 已知用量的失败结算 | 修复返回 usage 后业务校验失败仍占用预留 | 复用既有 reserve/settle 和价格策略 | 先复现，再验证 502/零值/缺失值/重复请求 | 共用 AI 计量中间件覆盖的操作 |
| 受限文字 AI 开关与明确提示 | 补齐实际产品入口和额度选择 | 默认关闭，按当前账号读取已有上下文 | CareHome/组件与 Axios、Taro 传输测试 | Web UI；mini 测试 |

详细日志、变更前副本、精确差异与本地构建记录：`D:/used-by-codex/outputs/tuyujia-ai-product-trial-20261016/`。Mongo 集成、真实供应商调用、生产发布和手机验收不在本批已完成证据内。
