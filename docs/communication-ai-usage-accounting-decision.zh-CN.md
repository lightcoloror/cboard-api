# 通信增强 AI Token 精确用量账本决策

## 状态

- 决策状态：已生效
- 最后更新：2026-07-22 11:48:32
- 执行工具 / 模型：Codex（GPT-5.6）
- 相关工程：`cboard-api`、CBoard Web、图语家微信小程序

## 意图

补齐原图语家 issue #1 中“Token 计量”的工程事实层，使每个认证用户能够看到当前 UTC 月由模型服务商真实回报的 Token 数量；同时不保存患者原文、图卡标签、识别文字、图片、音频或提示词，也不把尚未设计的价格、套餐和支付系统混入双向沟通核心。

## 决策

1. 直接复用现有 OpenAI/Azure OpenAI 兼容 Chat Completions 响应的 `usage.prompt_tokens`、`usage.completion_tokens` 与 `usage.total_tokens`；兼容只提供 `input_tokens`、`output_tokens` 的服务商响应，不引入 tokenizer 或自研估算算法。
2. 新增 `CommunicationAiUsage` 月度聚合模型，以 `user + UTC month + provider + model + operation` 唯一索引执行 Mongo 原子 `$inc`。只保存请求数、已回报/未回报请求数和三类 Token 数字，以及创建/更新时间。
3. 候选句、AI 重分词、粤语文字归一化、图片 OCR、图卡元数据建议和既有 `/gpt/edit` 在收到模型响应后、解析业务结果前写账本；这样即使模型返回格式不可用，已经产生的提供商用量也不会被漏记。
4. 服务商没有返回 Token 字段时不伪造 Token，仍把该请求计入 `unreportedRequestCount`。服务商提供 `total_tokens` 时原值保留；只有总数字段缺失时，才由同一响应已回报的输入与输出分项相加。
5. 新增认证 `GET /gpt/communication/usage`，只返回当前用户当前 UTC 月的数字汇总和按操作拆分。CBoard Web 与微信现有“增强服务状态”入口以向后兼容方式读取：旧 API 没有该路由时，原健康状态仍可显示。
6. 账本写入失败时返回有界 `503`，不暴露 Mongo URI 或内部错误；客户端继续使用既有本地候选、人工分词、手工输入和本地沟通降级。
7. TTS、粤语 ASR 和去背景没有统一 Chat Token 契约，继续由既有 1/2/4 点限额保护，不伪装成 Token 计费。
8. 用户永久删除 CBoard 账号时同步删除全部 `CommunicationAiUsage` 聚合，避免保留孤立的用户关联记录。

## 理由

- 当前 `openai@4.52.7` 类型和实际 Chat Completions 协议已经提供服务商结算侧 usage，直接复用比引入 tiktoken、WASM 或按字符估算更准确，也避免不同模型 tokenizer 漂移。
- 原有 `rate-limiter-flexible` 点数负责“请求前成本保护”，Token 账本负责“响应后实际用量事实”，两者职责不同且可以并存。
- 按用户、月份、提供商、模型和操作聚合，能够控制集合规模并支持对账；不存沟通正文则避免为了成本统计扩大患者隐私面。
- 明确记录未回报请求比将其写成零 Token 或猜测数字更诚实；未来只有在真实提供商都稳定回报 usage 后，才能基于该事实层讨论严格 Token 配额和价格。
- 双端只读取同一 API 契约，不复制计数逻辑；微信只增加轻量 JSON 和文字状态，不引入组件、插件、图片、音频或依赖。

## 证据

- API 聚焦账本、模型调用、控制器、Swagger、账号删除和索引回归 `50 passing`；全部无数据库 controller 单元回归 `232 passing`。
- 账本测试覆盖服务商字段归一化、无效/缺失 usage 的未回报标记、唯一 upsert 竞态重试、UTC 月份、跨操作汇总、内容字段不泄露、账号删除和存储错误有界化。
- CBoard Web 全量 `190 suites / 1251 tests / 72 snapshots` 与 production build 成功；新增状态展示使主 JS gzip 仅增加约 `219 B`，无新增依赖。
- 微信小程序全量 `64 files / 279 tests`、产物质量 `7/7`、TypeScript、ESLint、`184 app files / 29 CBoard core files` 边界和 production build 全部通过。质量门曾真实拦截新增可选链，改为旧基础库兼容判断后重建成功。
- 微信未压缩包体：main `1,249,564 B`、caregiver `559,596 B`、emergency `91,539 B`、management `493,073 B`、backup `589,688 B`、OCR `62,229 B`，全部低于 1.5 MiB 建议线；未新增插件、媒体或运行依赖。

## 生效范围

- 生效：六类 Chat Completions 操作的服务商回报 Token 审计、认证当前月查询、账号删除清理、CBoard Web 与微信增强状态展示、Mongo 唯一索引 readiness。
- 不变：患者离线表达、接收理解、人工修正、默认板、分词、matcher、WechatSI、本地/服务端朗读降级、图片来源许可和既有请求点数限额。
- 未完成：请求前 Token 预留、严格 Token 硬配额、价格换算、套餐、支付、退款、管理员账单、供应商账单对账和数据保留策略审批。
- 待验收：真实生产 Mongo 原子并发、真实 OpenAI/Azure 兼容服务商 usage、HTTPS fork 部署、微信合法域名和物理手机状态展示。
- 操作边界：本轮没有预览、上传、发布、部署、提交或推送；全程只使用后台 shell、补丁、测试、构建与文档接口，没有打开、聚焦、抬升或置顶微信开发者工具或任何应用窗口。

## 更新记录

### 2026-07-22 11:48:32 | Codex（GPT-5.6）

- 新建决策文档，记录精确用量事实层、隐私边界、限额分工、跨端展示和仍未完成的商业计费范围。

### 2026-07-22 11:48:32 | Codex（GPT-5.6）

- 收尾审查补充无效 usage 的未回报语义与账号永久删除清理，防止伪精确和孤立记录。
