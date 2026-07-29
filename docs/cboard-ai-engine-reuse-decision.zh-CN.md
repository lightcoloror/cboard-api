# CBoard AI Engine 复用审计与缺词补图排序决策

## 状态

- 决策状态：已生效
- 最后更新：2026-07-29 09:55:44
- 执行工具 / 模型：Codex（GPT-5.6）
- 相关工程：`cboard-ai-engine`、`cboard-api`、CBoard Web、图语家微信小程序

## 意图

完整审阅 CBoard 官方 AI Engine，优先复用已经验证的 AAC 图符检索能力；同时避免为了形式上的“全量复用”，把与图语家双向沟通语义不一致、缺少测试或已经面临上游停用的实现硬接入患者主链。

## 决策

1. 不把 `cboard-ai-engine` npm 整包直接安装进 `cboard-api`。
2. 复用其 ARASAAC 检索策略：先请求相关度排序的 `bestsearch`，无结果或失败时回退原 `search`。
3. 保留图语家既有的中文直查、经审核英文回退、候选数量限制、结果缓存、同请求合并、来源许可校验和同源图片代理。
4. 加入口语稳定且有原数据证据的 `勺/勺子 -> spoon`、`叉子 -> fork`、`碗 -> bowl`；不把“刀具”猜成餐刀，因为原 ARASAAC 中文记录的“刀具”实际对应 `razor`。
5. 暂不接入 AI Engine 的整板生成、Azure 内容安全和 Global Symbols v1 客户端。
6. 对 #19 缺词维护只选择性复用 AI Engine 的 AAC 生图提示约束；运行时继续复用 `cboard-api` 已有 OpenAI-compatible/Azure 客户端、认证、限流、Token 月额度、用量账本和 PNG 归一化，不安装或复制 AI Engine 整包。

## 理由

- AI Engine 的 `getSuggestions` 面向“一个主题生成一组整板词语”，图语家接收端需要的是“保留患者原文、可编辑分词、逐词安全匹配”，两者不是同一契约。
- AI Engine 使用 `openai@3.3.0`，当前 `cboard-api` 使用 `openai@4.52.7`；直接安装会引入两套 SDK 和重复配置。
- AI Engine 当前没有自动化测试，`generateCoreBoard` 中图片装配仍被注释，固定核心词和 OBF locale 也主要为英文，不能直接作为中文患者沟通主链。
- 内容安全过滤不能阻断“疼痛、自伤、虐待、暴力或紧急求助”等真实患者表达；双向沟通主链必须优先完整传达，再由照护流程处理风险。
- Global Symbols 官方已说明 v1 即将停用，v2 需要 API key 和限流处理；继续复制 AI Engine 的 v1 调用会制造短期债务。
- `bestsearch -> search` 是独立、无依赖且可回退的成熟策略，能直接改善候选相关度而不改变前端协议。

## 证据

- 本地源码审计：`cboard-ai-engine@1.9.0` 的 `src/engine.ts`、`src/coreBoardService.ts`、`src/lib/symbolSets.ts`、README 与 package 配置。
- 官方仓库：[cboard-org/cboard-ai-engine](https://github.com/cboard-org/cboard-ai-engine)。
- Global Symbols 官方迁移说明：[Developer API](https://globalsymbols.com/developer)。
- 2026-07-22 后台实测 `https://api.arasaac.org/v1/pictograms/en/bestsearch/apple` 返回 3 个候选。
- 真实餐具词复测：`刀具、勺、勺子、叉子、碗` 全部获得 ARASAAC 候选；“勺”从无结果修复为命中标准勺子 `2362`。
- 定向图符测试 `18 passing`；`cboard-api` 全部无数据库单元测试 `223 passing`。
- 未新增 npm 依赖、路由、客户端字段、图片或音频资源。

## 生效范围

- 生效：`cboard-api` 缺词在线补图的 ARASAAC 排序、回退和经审核餐具词典。
- 不变：CBoard Web 与微信小程序请求/响应协议、人工确认、离线沟通、默认板、分词、matcher、OpenSymbols 和图片代理安全边界。
- 暂缓：Global Symbols v2 provider，等待正式 API key、限流和许可代理方案；不把 v1 当作新代码基础。
- 排除：整板 AI 生成、患者表达内容拦截、公开图库投稿、部署、预览、上传或发布。
- 操作边界：本轮只使用后台 shell、只读网络验证、测试和文件修改；没有打开、聚焦、抬升或置顶微信开发者工具或任何应用窗口。

## 更新记录

### 2026-07-29 09:55:44 | Codex（GPT-5）

- **意图：** 消除 AI Engine 进程级可变配置导致多个账号、provider 或测试实例互相串用 URL/客户端的风险，并为未来复用 `cboard-api` 现有 AI provider 建立最薄的注入契约。
- **决策：** `initEngine()` 改为创建实例私有运行配置；新增中性的 `ChatCompletionClient`，允许服务端注入现有 provider；保留旧独立函数导出并明确它们只兼容“最后一次初始化”。当前仍不在 `cboard-api` 添加 `file:` 依赖、复制源码或接入 npm `1.9.0`。
- **理由：** 多实例隔离是服务器可复用的基本条件，注入客户端可避免 OpenAI v3/v4 双 SDK；但本地修复尚未形成正式可安装制品，直接接入会让构建只在当前目录结构成立，也会绕过既有发布与审查边界。
- **证据：** 新增双实例测试分别注入不同 ARASAAC URL 与 chat client，交叉调用后仍保持各自配置；旧独立导出只指向最后初始化实例。`npm run typecheck`、`8/8` tests、CJS `38.86 KB`、ESM `37.21 KB`、DTS `2.44 KB` 构建全部通过；README 已补注入与兼容说明。
- **生效范围：** `cboard-ai-engine` 本地 fork 的运行时隔离、公开类型和未来服务端 adapter 条件；不改变 `cboard-api` 依赖、路由、密钥、患者表达、微信包、部署或发布。只有形成可追溯的正式包/提交并完成 API adapter 复核后，才进入后端集成。

### 2026-07-28 20:15:46 | Codex（GPT-5.6）

- **意图：** 在当前三端核心回归已通过后重新运行 `cboard-ai-engine`，确认是否出现了可以直接接入但被遗漏的成熟模块，并把审阅结果写入源码账本，避免后续重复拉取或仅凭 README 决策。
- **决策：** 保留本地 `feature/tuyujia-mvp` 上已有的 Global Symbols v2、真实许可、并发有界检索和 Core Board 图片装配改造；继续只复用已经进入 `cboard-api` 的 `bestsearch -> search` 排序、受控 AAC 生图提示和图源许可边界，不把未发布本地整包通过 `file:`、复制源码或浏览器依赖接入 API/Web/微信。将本地仓库登记为 `source_reviewed / not_integrated_reference`，未来仅在有正式可安装修复版或稳定服务端建板契约时重新评估薄 adapter。
- **理由：** 当前引擎的核心能力仍是“照护者输入主题后生成整板草稿”，与患者表达候选、照护者逐词接收、缺词维护和安全重分词不是同一运行契约；它仍使用 OpenAI SDK v3 和进程级全局配置。直接接入会绕过现有认证、增强限流、Token 月额度、用量账本、导入复核和密钥隔离，而选择性复用已把成熟部分带入现有后端。
- **证据：** 本地源码和未提交改造逐文件复核；`npm test` 为 `6/6`、`npm run typecheck` 通过、`npm run build` 生成 CJS `38.26 KB`、ESM `36.60 KB` 与 DTS。npm registry 只读查询确认 `latest=1.9.0`；GitHub 公开页面仍显示公开仓库、189 commits 与 `1.9.0` latest release。直接 `git fetch` 仍失败于本机 Schannel/凭据 helper，GitHub REST 在当前账号返回 404，因此没有把远端 refs 冒充已同步。
- **生效范围：** `cboard-ai-engine` 源码审阅状态、`cboard-api` 选择性复用策略、源码账本和未来整板草稿适配条件；不改变现有患者/照护者 UI、AI 路由、依赖、lockfile、密钥、部署、预览、上传、提交或推送。

### 2026-07-27 00:01:34 | Codex（GPT-5）

- **意图：** 在不把整板 AI 或供应商密钥带入患者运行链的前提下，补齐 #19 中“公共图库与本机图片都没有合适结果时，由照护者生成、预览并确认一个设备私有图符”的维护缺口。
- **决策：** 新增受认证的 `/gpt/communication/pictogram-generation` 薄适配器，选择性复用 AI Engine 的 AAC 构图提示规则，并直接复用 API 现有 provider、增强限流、Token 月额度、用量账本和 `normalizePublicPictogramImage`。响应必须是有界 PNG、声明 `device-private`、不声明公共许可、披露 provider/model；Web 与微信必须先预览，确认后才进入既有缺词 `onReview`，取消或保存失败清理微信临时文件。
- **理由：** AI Engine 整包仍包含与缺词单图不同的整板生成契约、未发布本地修复和重复 SDK 风险；但其“居中、粗轮廓、高对比、白底、无文字/Logo/水印”的 AAC 图像提示是独立可复用策略。把生成边界留在 `cboard-api` 可避免客户端密钥泄露，并让付费调用共享现有防滥用设施；设备私有和人工确认则避免把模型输出误当成有公共许可的图库素材。
- **证据：** API 图符 provider/controller/Swagger/限流/Token/用量聚焦 `58 passing`；CBoard Web API、共享 attribution/runtime、缺图队列与父组件 `6 suites / 112 tests` 及等价 production build 通过；微信 AI port、全量 `75 files / 333 tests`、TypeScript、ESLint、`211 app / 30 core` 边界与 production build 通过。微信主包未压缩 `1,249,738 B`，距 1.5 MiB 建议线 `323,126 B`，本次未新增静态图片、音频、插件或依赖。API 全控制器套件在本机无 MongoDB/SMTP/测试密钥时 `369 passing` 后超时，不能作为本次回归失败或全量通过证据。
- **生效范围：** CBoard Web 与微信家属缺图维护、`cboard-api` 可选图像模型配置及共享设备私有来源契约；不进入患者自动表达、不自动采用、不上传公共图库、不声称生成图具备公共许可、不接整板生成、不部署、不预览、不上传、不发布、不提交或推送。全程仅后台操作，未打开、聚焦、抬升或置顶开发者工具窗口。

### 2026-07-26 17:58:16 | Codex（GPT-5.6）

- **意图：** 在 `cboard-ai-engine` 已完成 Global Symbols v2、真实许可和 Core Board 图片链修复后，重新判断是否应立即把整板生成接进 CBoard Web 或 `cboard-api`，避免旧审计依据过时，也避免“修好了库”被误写成“用户已经能用 AI 建板”。
- **决策：** 继续保留 `cboard-ai-engine` 作为可发布、可独立测试的服务端库，但当前不把它以本地相对路径、未发布 tarball、浏览器依赖或复制源码的方式接入 `cboard-api`。图语家双向沟通继续复用现有受认证、速率限制、Token 月额度和用量账本保护的 `/gpt/communication/*` 路由；板文件继续复用 CBoard 的 OBF/OBZ 导入、复核和确认流程。只有官方 AI Engine 的修复版本形成稳定可安装制品，或 CBuilder 提供公开服务端契约后，才新增薄 adapter，把生成草稿送入现有导入复核，不直接写入患者板。
- **理由：** `cboard-ai-engine` 的整板建议面向照护者创建主题板，不是患者选图生成句子、照护者文字转图片、缺词补图或重分词的运行依赖。当前三个代码库没有公开的 CBuilder 消费端；直接添加 `file:../cboard-ai-engine` 只在本机成立，依赖官方 `1.9.0` 又会绕过本轮未发布修复。浏览器直连会泄露 AI/Global Symbols 密钥，复制实现会违反优先复用原则；新增独立路由还必须复用现有配额、用量、超时和导入审核，不能以“能返回 JSON”代替完整产品边界。
- **证据：** `cboard-api` 已有 OpenAI-compatible/Azure provider、用量记账、Token 月额度、增强限流及 `/gpt/communication/sentences`、`resegment`、OCR、图卡元数据等路由；CBoard Web 已有 OBF/OBZ 解析、冲突复核和确认导入。两个工程均未依赖 `cboard-ai-engine`。CBoard 官方组织目前公开的是 `cbuilder-landing`，未找到可复用的 CBuilder 源码或公开建板 API；官方 npm 安装说明仍指向 `cboard-ai-engine@1.9.0`。本地修复版已通过 6 项测试、TypeScript 和 CJS/ESM/DTS 构建，但尚未提交、发布或部署。
- **生效范围：** `cboard-ai-engine` 的未来服务端消费者、`cboard-api` AI 路由边界、CBoard Web 导入审核和图语家开发顺序。不会删除或弱化现有候选句、重分词、OCR、图卡建议、缺词搜索、Global Symbols v2、ARASAAC/OpenSymbols、本地模板或人工维护；不新增依赖、lockfile、路由、UI、密钥、部署、提交或推送，也不把库级测试冒充用户可见功能。

### 2026-07-26 10:21:32 | Codex（GPT-5.6）

- **意图：** 纠正本机 GitHub 认证异常可能造成的“官方 AI Engine 已消失”误判，并确认是否需要再次同步或重做已经接入的能力。
- **决策：** 继续以本地 `cboard-ai-engine@1.9.0` 作为已审阅上游快照；公开 GitHub 页面仍显示 `cboard-org/cboard-ai-engine`、189 条提交和 `1.9.0` 最新 release，因此当前不重复拉取、不重装 npm 包，也不改变既有选择性复用边界。待本机 Git HTTPS/`gh` 认证恢复后，再只读 fetch refs 并比较是否有 `1.9.0` 之后的新提交。
- **理由：** 本机 `gh api` 的 404 与 `git ls-remote` 的 `SEC_E_NO_CREDENTIALS` 是互相不同的认证失败，不能证明公开仓库被删除；本地 HEAD 为版本提交 `1c31981961607a33aad43b7dd4d894068eb1b8ef`，`package.json` 版本也是 `1.9.0`，已经足以继续本轮代码审计。未经 refs 证明就重拉、重装或删除本地 fork 都会增加脏工作树风险。
- **证据：** 公开仓库页面仍展示 GPL-3.0、`1.9.0` release、189 commits、ARASAAC/Global Symbols 与 OpenAI 能力；本地 `git log`、tag、README、`src/engine.ts`、`src/coreBoardService.ts` 和 `src/lib/symbolSets.ts` 与此前审计对象一致。本机认证 API 返回 404，Git HTTPS 返回 `SEC_E_NO_CREDENTIALS`，故只记录认证通道待恢复，不声称完成最新 refs 同步。
- **生效范围：** `cboard-ai-engine` 上游状态记录、cboard-api 的选择性复用策略和后续同步流程；不改变患者表达、接收匹配、AI 候选、图片搜索、前端协议或生产配置。本轮未写入密钥、安装依赖、提交、推送、预览、上传、发布或部署，也未打开、聚焦、抬升或置顶任何窗口。

### 2026-07-22 11:14:17 | Codex（GPT-5.6）

- 新建决策文档并记录首个可复用切片、拒绝硬接的边界与验证证据。
