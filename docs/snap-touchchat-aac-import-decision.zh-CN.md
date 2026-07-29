# Snap 与 TouchChat AAC 导入服务端转换决策

## 变动 1：供应商文件只在服务端转换

- **意图：** 让已有 Snap `.sps/.spb` 和 TouchChat `.ce` 图库的家庭能够迁入图语家，而不要求重建板面，也不把 SQLite、ZIP 和原生依赖塞进 Web 或微信小程序。
- **决策：** 精确复用 `@willwade/aac-processors@0.2.20` 的 Snap 与 TouchChat 处理器，通过登录后 multipart 端点 `/communication/aac-import/convert` 转换为版本化 Open Board 文档响应；源文件仅以内存请求体参与转换，不落盘、不进入账号 settings。
- **理由：** 上游已经实现供应商格式解析；把重依赖留在 Node 服务端，客户端只复用现有 Open Board 复核、合并、图片暂存与回滚链，风险和重复代码最少。
- **证据：** 真实 AACTree 先生成 Snap/TouchChat 文件，再由上游 parser 和本服务转换器读取的集成测试通过；AAC 聚焦共 `13 passing`。
- **生效范围：** cboard-api 的 Snap/TouchChat 转换端点、CBoard Web Settings 导入和微信“照护设置 → 图片库维护”导入；不进入患者表达页，不改变表达、接收、分词、匹配或语音。

## 变动 2：对不可信 AAC 文件施加资源与并发边界

- **意图：** 防止压缩包、SQLite、超大图片或异常板面耗尽服务内存和事件循环。
- **决策：** 输入上限 20 MiB，输出上限 32 MiB，最多 100 页、5000 按钮、100×100 网格；单图 5 MiB、图片总量 20 MiB；先校验 Snap SQLite 与 TouchChat ZIP 签名；同一进程最多并发转换 2 个，繁忙时返回 429 与 `Retry-After`。
- **理由：** 供应商文件完全由用户提供，不能依赖扩展名或 parser 自行保护；有界失败比后台无上限解析更符合沟通服务可用性要求。
- **证据：** 单元测试覆盖格式、签名、输入规模、页/按钮规模、图片跨板隔离、并发繁忙、鉴权、缓存头和安全错误响应；API 无数据库控制器单元全量 `337 passing`。
- **生效范围：** 仅限新增 AAC 转换请求；不改变既有 JSON/OBF/OBZ/GRD/Gridset 导入上限，也不启动队列、持久化任务或云存储。

## 变动 3：两端继续复用同一 Open Board 审查管线

- **意图：** 避免为 Snap/TouchChat 新建第二套图库写入逻辑，让家属仍能在实际覆盖本地图库前检查结果。
- **决策：** Web adapter 和微信 upload port 只负责上传与校验版本化响应；返回的 Open Board documents 继续交给既有导入审查、板面合并、图片暂存和失败回滚。微信临时文件只用于 `Taro.uploadFile`，请求结束后仅删除本次创建的临时文件。
- **理由：** 复用已验证的中性导入契约可保持 Web/微信行为一致，也能把低频维护能力固定在 settings/backup 分包，而不是患者高频表达主包。
- **证据：** Web AAC/API/Gridset 回归 `4 suites / 64 tests / 3 snapshots`；微信全量 `67 files / 303 tests`、TypeScript、ESLint 和 `190 app / 29 core` 边界通过。
- **生效范围：** CBoard Web Settings 文件导入及微信家属图片库维护；Snap/TouchChat 要求登录和可访问的 cboard-api，不提供离线本地解析。

## 变动 4：固定 XML 解析器版本并锁住微信分包归属

- **意图：** 保持 Gridset 与 AAC 导入可重复构建，防止依赖漂移把微信不兼容语法或服务器端点带入主包。
- **决策：** CBoard 精确固定 `fast-xml-parser@4.5.3` 并写入 `yarn.lock`；微信产物门禁要求 `/communication/aac-import/convert` 只能出现在 `packages/backup`，同时继续扫描可选链、空值合并、包体、插件、组件和静态资源。
- **理由：** `fast-xml-parser@5.10.1` 的产物包含 `?.`/`??`，会触发现有微信兼容门禁；4.5.3 保持当前 parser API 且不需要转译 `node_modules`。端点归属断言可阻止低频维护代码回流患者主包。
- **证据：** 微信 production build 与输出质量门通过；未压缩 main `1,249,564 B`、backup `884,442 B`，均低于 1.5 MiB 建议线。CBoard 独立输出目录 production build 成功，原 `build` 目录仍受 Windows 文件锁影响。
- **生效范围：** CBoard 的 XML 解析依赖锁和微信构建质量门；不升级其他依赖，不纳入 `package-lock.json`，不处理 vendored Gridset 的既有 ESLint 警告。

## 变动 5：显式保留 TouchChat 图片能力缺口与许可证不确定性

- **意图：** 不把“文字和布局可导入”误称为 TouchChat 完整迁移，也不隐瞒第三方包许可证元数据冲突。
- **决策：** 响应能力字段明确 Snap 可提取嵌入 PNG/JPEG，而当前 TouchChat 上游 parser 不提取 `Images.c4s` 自定义图片并返回 warning；`@willwade/aac-processors` 虽在 package metadata 标记 MIT，但随包 LICENSE 是 GNU GPL，按更保守的 GPL-3.0 管理并只放入 GPL-3.0 服务端。
- **理由：** 能力缺口必须在导入复核前可见；许可证冲突在 upstream 澄清前不能按更宽松条款推断。服务端隔离同时避免把约 66 个传递依赖和 `better-sqlite3` 带入小程序。
- **证据：** 安装包 `package.json` 为 `license: MIT`，随包 `LICENSE` 首行为 `GNU GENERAL PUBLIC LICENSE`；TouchChat 集成测试确认文字、布局和导航可转换，响应对自定义图片限制给出结构化能力与警告。
- **生效范围：** 当前版本的合规记录与用户提示；不代表加密文件、TouchChat 自定义图片、声音、供应商动态动作、云端长期文件保存或真机大型文件已支持。

## 记录

- **执行者：** Codex（GPT-5）
- **时间：** 2026-07-24 00:43:18
- **操作边界：** 本轮未预览、上传、发布、部署、提交或推送；没有打开、激活、聚焦、抬升或置顶微信开发者工具及浏览器窗口。

## 变动 6：复用 Bravo AAC 补齐 TouchChat 自定义图片

- **意图：** 消除 TouchChat `.ce` 已能导入文字和布局、但家属自定义图片全部丢失的迁移缺口，同时继续避免自行反向工程供应商格式。
- **决策：** 保留 `@willwade/aac-processors@0.2.20` 作为板面主解析器，并机械适配 [Bravo AAC](https://github.com/OSUBlakester/BravoGCPCopilot) Apache-2.0 实现中的稳定关联链：从 `.c4v` 的 `buttons.symbol_link_id → symbol_links.rid` 定位 `Images.c4s.symbols.rid`，只把有明确 PNG/JPEG 文件签名、单图不超过 5 MiB、总计不超过 20 MiB 的嵌入图片挂回解析树。ZIP 不解压到目录，两个 SQLite 数据库分别限制为 40 MiB，只在系统临时目录短暂打开并在请求结束清理。上游来源固定到提交 `e23ec815d9e9cd1985441ae1fc2b62467b6562ee`，Apache-2.0 许可与修改说明随代码保留。
- **理由：** AACTools Node 主解析器尚未实现 `resolvedImageEntry`；其 Python 仓库中的可选 helper 没有接入主解析器，且示例查询与公开 `Images.c4s` schema 不一致。Bravo AAC 已在真实 TouchChat 迁移功能中采用正确 RID 关联，许可证与当前 GPL-3.0 服务端兼容。只适配这段服务端算法比引入 Python、FastAPI、Firebase、GCP 或在 Web/小程序内安装 SQLite 更小、更可维护。
- **证据：** 新增真实 ZIP + 两个 SQLite 数据库单元测试，覆盖有效 PNG 和不支持载荷；新增 `AACTools TouchChatProcessor → semantic_id → Bravo RID 关联 → Open Board images/image_id` 集成测试。AAC 聚焦 `12 passing`，cboard-api 无数据库单元全量 `352 passing`，Prettier、Node 语法检查和 `npm ls` 依赖闭包全部通过。公开 AACTools `WordPower42 Basic SS_UK.ce` 样本包含 9,321,472 B `.c4v` 与 32,768 B `Images.c4s`，其中 `symbols` 为空；该大型样本因超过现有 100 板面安全上限被明确拒绝，未以放宽防护伪装为图片回归成功。
- **生效范围：** cboard-api 的 TouchChat 登录导入，以及已经复用该转换端点的 CBoard Web Settings 和微信“照护设置 → 图片库维护”；不增加 Web/小程序依赖或包体，不进入患者表达页，不改变 Snap、JSON、OBF/OBZ、GRD、Gridset、分词、匹配、语音、AI、同步或发布。只恢复 `.ce` 内实际嵌入且直接编码为 PNG/JPEG 的自定义图片；未嵌入的 TouchChat 商业符号库、压缩/专有图像载荷、声音、动态动作、加密文件、超过 100 板面的大型词库和真机文件交互仍不声称支持。本轮未预览、上传、发布、部署、提交或推送，也没有打开、激活、聚焦、抬升或置顶任何窗口。
- **记录：** Codex（GPT-5），2026-07-25 21:19:04。

## 变动 7：真实大型 TouchChat 词库继续有界导入

- **意图：** 让真实家庭使用的完整 TouchChat 词库可以进入现有跨端导入闭环，避免把此前为早期验证设置的 `100` 板面、`5000` 按钮上限误当成 Open Board Format 或 AACTools 的标准限制。
- **决策：** 继续复用 AACTools 的 TouchChat 解析树和既有 Open Board 转换管线，只把总量上限提高到最多 `500` 板面、`20000` 按钮；重复源按钮 ID 保留第一次出现的 ID，后续按遍历顺序稳定改写为 `--2`、`--3` 等后缀，同时维持原网格顺序。输入 `20 MiB`、输出 `32 MiB`、单图 `5 MiB`、图片总计 `20 MiB`、网格 `100×100` 和并发 `2` 的安全边界不变。CBoard Web 同步接受 `500/20000` 的 Open Board 文档集合，微信图库上限、归档上限和结构化图片库上限同步到 `20000`；微信本机持久化优先写入用户目录 A/B 双槽 JSON，保留上一份可读快照，并兼容旧 storage 自动迁移和文件 API 失败回退。
- **理由：** [Open Board Format](https://github.com/open-aac/openboardformat) 与 [AACTools AACProcessors](https://github.com/AACTools/AACProcessors-nodejs) 均没有规定 `100/5000` 上限；真实公开样本已经超过旧阈值。直接取消边界会放大不可信文件的内存风险，而把上限调整到覆盖真实样本并继续保留字节、图片、网格和并发限制，可以兼顾迁移可用性与服务稳定性。微信单个同步 storage 键不适合承载万级图卡，用户目录双槽文件又能复用平台原生同步文件 API，不需要新增数据库或第三方持久化依赖。
- **证据：** AACTools 公开 `WordPower42 Basic SS_UK.ce` 样本真实解析为 `348` 个板面、`11,953` 个按钮，源解析树 JSON 为 `14,720,184` 字节；当前 cboard-api 在约 `750 ms` 内转换成 `348` 份 Open Board 文档、`11,953` 个按钮和 `1,769,593` 字节响应，无 warning。样本中 `6` 个板面存在共 `31` 个重复按钮 ID，稳定后缀策略保持全部格位且消除输出重复 ID。自动化覆盖 `348/12180` 大型树、重复 ID、超过 `500/20000` 的拒绝；AAC 聚焦 `15 passing`，cboard-api 无数据库单元全量 `355 passing`。CBoard 全量 `200 suites / 1352 tests / 72 snapshots` 与隔离 production build 通过。微信全量 `72 files / 321 tests`、`7/7` 质量门、TypeScript、ESLint、`202 app / 30 core` 边界和 production build 通过；main `1,249,620 B`、backup `913,444 B`，均低于 `1.5 MiB` 建议线。
- **生效范围：** cboard-api 的 Snap/TouchChat 有界转换、CBoard Web 的 Open Board 接收与图库归档，以及微信“照护设置 → 图片库维护”的大型图库保存、恢复和旧 storage 迁移；不进入患者表达页，不改变分词、匹配、语音、AI、账号同步或发布。专有/压缩 TouchChat 图片载荷、声音、供应商动态动作、加密文件、真实部署 API 和手机文件选择/双槽恢复仍待验收；微信 backup 页单文件 `434 KiB` 的构建警告保留为后续拆分项。本轮未预览、上传、发布、部署、提交或推送，也没有打开、激活、聚焦、抬升或置顶任何窗口。
- **记录：** Codex（GPT-5），2026-07-26 08:45:41。

## 变动 8：压缩图片与按钮录音保持显式未实现

- **意图：** 在补齐 TouchChat 自定义 PNG/JPEG 后继续寻找压缩/专有图片和按钮录音的成熟开源实现，同时防止能力声明超过真实证据。
- **决策：** 固定并运行 Node AACTools `221c8c924c8348b3d373f12d86952b01f2b8ddb7`、Bravo AAC `a0189275fab53bd2f2bd05e3107b4a3a4dea68f9` 和 Python AACTools `ff9cfb40ba518a5ba2df170fb49b48dfd57f64ad`；继续保留当前文字、布局、导航与原始 PNG/JPEG 路径，不新增压缩载荷 decoder、录音映射或 Python 服务。
- **理由：** 三个来源都没有从真实 `.ce` 完成这两类媒体往返：Node helper 明确未实现图片且主 parser 不读音频；Bravo 只接受 PNG 签名；Python 可选图片查询不符合真实 `Images.c4s` schema。猜测 `compressed/type` 或把人工挂载字段当成文件能力会产生错误媒体与患者表达风险。
- **证据：** Node TouchChat 定向 `7 suites / 40 tests` 通过；Python 主逻辑 `7 passed`，唯一错误为保存后 SQLite 句柄导致 Windows teardown 无法删除；公开 `example.ce` 图片表为空；GitHub schema 组合检索未发现可运行公开 decoder。完整报告位于 PicInterpreter 仓库 `docs/touchchat-compressed-media-source-review-2026-07-28.md`。
- **生效范围：** cboard-api TouchChat 导入能力说明和后续进入门；不改变当前 API、依赖、warning、安全上限或 Open Board 输出，不影响 Web/微信既有导入。本轮未预览、上传、发布、部署、提交或推送。
- **记录：** Codex（GPT-5.6），2026-07-28 19:40:59。
