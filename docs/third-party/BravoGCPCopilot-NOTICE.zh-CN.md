# BravoGCPCopilot TouchChat 图片关联适配说明

## 变动 1：记录第三方来源、许可证与修改边界

- **意图：** 让 TouchChat 自定义图片适配的技术来源、法律来源和本项目修改一眼可审计，避免把第三方成熟算法误写成图语家自研。
- **决策：** `api/helpers/touchChatCustomImages.js` 的图片 RID 关联查询适配自 [OSUBlakester/BravoGCPCopilot](https://github.com/OSUBlakester/BravoGCPCopilot) 的 `touchchat_ce_parser.py`，固定参考提交 `e23ec815d9e9cd1985441ae1fc2b62467b6562ee`。原项目版权为 `Copyright 2024 Blake Thomas`，许可证为 Apache License 2.0；本目录保留完整许可证副本。本项目将 Python/SQLite 文件路径实现改为 Node.js、内存 ZIP、临时只读 SQLite 和有界 PNG/JPEG 数据 URL，只保留 TouchChat 自定义图片关联，不复制 Bravo 的 FastAPI、Firebase、GCP、AI 或 UI。
- **理由：** 复用已经运行的开源实现符合图语家“工具优先、少自研”的工程原则；固定提交、版权和修改说明同时满足可追溯性，并让后续维护者能够核对上游变化。
- **证据：** 上游仓库根 `LICENSE` 为 Apache License 2.0，README 明确列出 TouchChat 导入和自定义图片支持；本地集成测试证明关联结果进入 Open Board `images/image_id`，API 全量无数据库单元回归为 `352 passing`。
- **生效范围：** 仅限 `api/helpers/touchChatCustomImages.js` 及其测试和文档；不改变 cboard-api 总体 GPL-3.0-only 许可证，不授予 TouchChat 商业符号库内容的再分发权，也不表示上游作者为图语家提供担保或背书。
- **记录：** Codex（GPT-5），2026-07-25 21:19:04。
