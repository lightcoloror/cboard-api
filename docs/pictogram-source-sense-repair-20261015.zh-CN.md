# 图语家补图来源词义修复：开心果与洗手液

2026-10-15 11:18:27（Asia/Shanghai）｜Codex（具体运行模型未独立核实）

- **意图**：修复开心果被泛化为开心/水果、洗手液被来源错误中文标签配成肥皂块，以及英文 liquid soap 混入沐浴露。
- **决策**：继续复用 `cboard/src/common/communicationSupport/pictogramSemantics.js` 的概念、来源身份校验、候选相关性、排序和人工确认；通过现有脚本生成 API 副本。没有新增匹配/缓存系统。
- **理由**：来源中文标签可能错误，英文标签也可能跨物品混用。必须保留原文并结合核实过的具体来源 ID；不能把查询词重新当作图片词义。
- **证据**：`test/fixtures/pictogram-source-senses-20261015.json` 为公开 OpenSymbols 真实响应摘录；ARASAAC 3335 的 shower gel/liquid soap 图片为沐浴露。视觉证据与真实 API/离线测试记录位于 `D:/used-by-codex/outputs/tuyujia-source-senses-20261015/修复与验收.md`。
- **生效范围**：API、新版 Web 和小程序共用语义版本 `2026-10-15.1`。API 与客户端应一起发布。未确认旧版本候选重搜；已人工确认选择与历史不自动更改。本轮未部署。

验证：API 33 项、Web 757 项、小程序 57 项通过，类型与生成副本契约通过。真实候选下载并看图；两词分别进行 Web 40 项/小程序 8 项离线回放通过。小程序文件下载是适配器模拟，不等同真机验收。
