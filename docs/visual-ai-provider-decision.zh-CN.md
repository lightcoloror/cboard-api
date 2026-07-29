# 视觉 AI 服务端认证、额度与私密结果组合验收

- **记录时间：** 2026-07-29 09:02:35
- **执行者：** Codex（GPT-5.6）

## 意图

把图语家的图片识字、个人图卡元数据建议和缺词 AI 图符生成，从“provider 与客户端代码存在”推进到 CBoard 普通用户认证、Swagger multipart/JSON、官方 OpenAI-compatible SDK、Mongo 用量账本和私密结果响应的完整工程证据，同时保持照护者最终编辑和确认权。

## 决策

1. 继续复用 `openai@4.104.0` 官方 SDK、现有通用 AI provider、JWT、Swagger 路由、Mongo 月额度和三端现有 adapter，不自研 OpenAI-compatible HTTP 客户端，也不新增第二套视觉 API。
2. 新增显式环境门控的隔离 Mongo + Nock 组合门。Nock 只替代收费公网响应，官方 SDK、生产认证、multipart、Data URL、图片生成请求、PNG 归一化、用量结算和控制器均真实执行。
3. OCR 与元数据原图只在单次请求内转成内存 Data URL；文件名、服务端密钥和本地路径不得进入 provider JSON。结果继续标记 `sourceStored: false`，并由照护者修改后才进入既有文字或图卡流程。
4. AI 生成图继续归一化为 300×300 PNG，只标记 `device-private`，不声明公共许可、不自动保存或发布；传给 provider 的最终用户标识只使用 CBoard 用户 ID 的 SHA-256。
5. OCR、元数据、生成图、去背景、ASR 和 TTS 的成功响应统一设置 `Cache-Control: no-store, private` 与 `X-Content-Type-Options: nosniff`。

## 理由

- 方法 stub 无法证明 JWT、Swagger、multipart、官方 SDK 请求体、Mongo reservation/settlement 和响应隐私头能组合工作。
- 家庭照片、截图文字、患者意图和生成图都可能包含敏感信息，即使服务端不落库，浏览器、代理或中间缓存仍需要明确禁止保存。
- OCR 和视觉分类可能误识别；自动进入分词、matcher 或图库会放大错误，必须保留“识别/建议 → 人工编辑 → 手动继续”的边界。
- 模型生成内容没有自动获得公共图符许可，私密草稿与 ARASAAC/OpenSymbols 等可归属公共来源不能混为一类。
- 复用官方 SDK 与现有额度基础设施，可以减少协议漂移和重复维护，并让三种视觉调用进入同一个用户月度预算。

## 证据

- 官方 SDK 源码：<https://github.com/openai/openai-node>，本地固定提交 `7704e54f048c75f5fd96fa26e2b7b56cf0900a80`，版本 `4.104.0`，Apache-2.0。
- 官方 `tests/api-resources/images.test.ts` 在本机使用等价本地 HTTP 响应运行 `6/6`，覆盖图片 variation、edit、generate 的必填与可选参数；上游 Unix 脚本依赖 `lsof`，因此未把 Windows 脚本兼容问题误写成 SDK 失败。
- 认证视觉 HTTP/Mongo 组合门 `3/3`：匿名 OCR 返回 403 且未建立 provider mock；普通用户 OCR、元数据和图片生成均返回 200。
- 两次视觉输入都只发送与原始 JPEG 字节完全一致的内存 Data URL；provider JSON 不含上传文件名、本地路径或 API key。
- 图片生成真实发送 `gpt-image-1`、`1024x1024`、低质量 PNG、无文字 AAC prompt 和 SHA-256 用户标识；返回值被归一化为 300×300 PNG，并保留 `device-private`、`sourceStored: false`、无公共许可声明。
- OCR、元数据和图片生成 provider 实报用量分别为 20、25、32，Mongo 当前用户月额度最终为 77；所有视觉成功响应均为 `no-store, private` 与 `nosniff`。
- 背景移除认证 HTTP/Mongo 回归 `2/2`，同样验证私密响应头；视觉/provider/controller/额度聚焦 `59/59`，cboard-api 全量单元 `377/377`。

## 生效范围

- 生效于 `/gpt/communication/ocr`、`/gpt/communication/pictogram-metadata`、`/gpt/communication/pictogram-generation`、`/gpt/communication/background-removal` 的成功响应和视觉 AI 集成验证命令。
- 不改变 CBoard Web 或微信小程序的入口、人工编辑顺序、matcher、分词、保存确认、默认图库、公共图源或离线兜底；客户端无需改动。
- 没有真实模型凭据、收费请求、家庭照片、公网部署、微信合法域名或物理手机，因此不证明生产视觉质量、延迟、费用、供应商保留政策和患者可理解性已经通过。
- 本轮未使用 Computer Use，未打开、聚焦或置顶微信开发者工具，未预览、上传、发布、部署、提交或推送。
