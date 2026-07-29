# 复用 CBoard 订阅与支付基础的安全加固决策

## 状态

- 决策状态：已生效（工程级）
- 最后更新：2026-07-23 12:46:10
- 执行工具 / 模型：Codex（GPT-5）
- 相关工程：`cboard-api`、CBoard Web、图语家微信小程序

## 意图

完整复用 CBoard 已有的 PayPal、Google Play 和 App Store 订阅基础，而不是为图语家重新开发一套支付系统；同时先修复原实现中客户端可指定订阅归属、状态和交易内容等安全缺口，使后续接入套餐权益或微信支付时有可信的服务端事实来源。

## 决策

1. 保留 CBoard 现有 `Subscription`、`Subscribers`、PayPal helper、Google Play 校验和 App Store 校验路径，不新增支付 SDK、数据库或第二套账号体系。
2. 普通用户创建订阅记录时，`userId` 必须来自当前认证账号，初始状态固定为 `not_subscribed`，客户端提交的状态和交易内容不生效；管理员仍保留受控维护能力。
3. 普通用户只能在未激活阶段选择套餐，不能直接修改归属、状态或交易。交易校验前先加载订阅记录并验证归属，避免对他人记录触发供应商请求。
4. 套餐标识、价格和供应商计划 ID 以服务端 `Subscription` 目录为准。客户端选择必须能映射到激活的 `subscriptionId + planId/paypalId`，不能用自报标题或价格完成购买确认。
5. PayPal Web 创建订阅时传入 CBoard 用户 ID 作为 `custom_id`，服务端同时核对远端 `id`、`custom_id`、`plan_id` 和 `ACTIVE` 状态。取消前先核对本地归属与平台。
6. Google Play 与 App Store 继续复用既有官方校验链，并额外核对远端产品与服务端套餐。购买令牌、收据、签名、付款人信息和 facilitator access token 不返回客户端，也不保存为通用响应。
7. 服务端只保存和返回有界交易摘要；Swagger 明确 `SubscriberProduct`、`SafeSubscriptionTransaction` 和脱敏后的 provider metadata。
8. 会全局同步并删除过期套餐的 `GET /subscription/synchronize` 改为仅管理员可调用。
9. 微信小程序只消费登录响应中的脱敏订阅摘要并只读展示，不在本轮创建订单、调用 `wx.requestPayment` 或自动扣费。
10. 已取消订阅只在服务端确认的到期时间之前继续视为有效；到期后允许用户重新选择套餐。没有到期时间或时间损坏的旧记录保持保守锁定，等待供应商同步或管理员修复。
11. 删除订阅记录除 Swagger 的管理员 scope 外，控制器再次检查认证角色；即使路由中间件配置被误改，普通用户也不能进入删除数据库调用。
12. Android 购买继续复用 Google Play 服务端校验，但进入模型前先执行有界规范化：receipt 最大 64 KiB、purchase token 最大 4096 字符、产品必须等于服务端套餐目录，并以跨订阅者唯一 transaction ID 拒绝交易重放。Swagger 只在真实交易端点声明该请求体。

## 理由

- CBoard 已经提供跨 Web、Android 和 iOS 的订阅模型与供应商适配，复用它比复制一套支付状态机更符合“以成熟底座减少开发量”的总决策。
- 原接口允许客户端创建其他用户的订阅、提交任意状态或交易，并在归属校验前访问供应商；这些行为会让“已订阅”失去可信度，也可能取消或探测他人的订阅。
- [PayPal Subscriptions API](https://developer.paypal.com/docs/api/subscriptions/v1/) 原生提供 `custom_id`、`plan_id` 和订阅状态，直接用这些服务端事实绑定 CBoard 账号，不需要自造签名协议。实施流程参考 [PayPal Subscriptions 集成文档](https://developer.paypal.com/docs/subscriptions/integrate/)。
- 微信支付必须由服务端创建小程序订单，再由客户端调用 `wx.requestPayment`；退款还需要独立回调和证书链。官方依据见[小程序下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791897)、[调起支付](https://pay.wechatpay.cn/doc/v3/merchant/4012791898)和[退款结果通知](https://pay.wechatpay.cn/doc/v3/merchant/4012791906)。
- [微信支付 API v3 官方 GitHub 组织](https://github.com/wechatpay-apiv3)目前提供多语言参考实现，但没有与当前 Node API 完全等价的官方一键 SDK；在商户号、正式 AppID、API v3 密钥、平台证书、回调域名和商品类型未确定前，不应伪装成已完成支付。

## 证据

- cboard-api 订阅安全聚焦回归：`22 passing`，覆盖伪造归属、伪造状态/交易、归属校验顺序、PayPal 用户与计划绑定、敏感字段脱敏、越权取消/删除、取消后到期重选、Android 超限输入、跨订阅者交易重放和 Swagger 请求体落点。
- cboard-api 全部无数据库单元回归：`303 passing`。
- Swagger v2 校验：`0 errors`；保留 1 条与本次无关的既有 `UNUSED_PARAMETER` 警告（`phraseToEdit`）。目标文件 `git diff --check` 通过，仅有 Git 的 LF/CRLF 工作树提示。
- CBoard Web 订阅 payload 回归：`2 suites / 3 tests / 1 snapshot`；production build 通过。PayPal payload 包含服务端套餐标识和当前 CBoard 用户 `custom_id`，不再持久化 facilitator access token。
- 微信小程序全量回归：`65 files / 289 tests`；质量门 `7/7`、TypeScript、ESLint、`186 app files / 29 CBoard core files` 边界和 production build 通过。
- 微信未压缩包体：main `1,249,564 B`、caregiver `562,730 B`、emergency `94,003 B`、management `503,194 B`、backup `592,152 B`、OCR `64,693 B`，均低于 1.5 MiB 建议线。

## 生效范围

- 生效：现有 PayPal、Google Play、App Store 订阅记录的归属、套餐目录核对、交易响应脱敏、PayPal 取消边界、全局套餐同步权限、Web 计划绑定和微信只读订阅状态。
- 不变：图语家的患者表达、照护接收、分词、人工修正、图文匹配、朗读、历史、私有图库和本地离线主链。
- 未完成：微信支付下单、`wx.requestPayment`、商户证书和回调验签、价格版本、套餐权益、退款、发票、管理员账单、供应商对账和支付风控。
- 待验收：真实 Mongo、PayPal/Google/App Store sandbox、真实商店账号、真实商户配置、公网 HTTPS、微信合法域名和物理设备端到端购买。
- 操作边界：本轮没有预览、上传、发布、部署、提交或推送；没有打开、激活、聚焦、抬升或置顶微信开发者工具或任何应用窗口。

## 更新记录

### 2026-07-22 21:32:34 | Codex（GPT-5）

- 新建决策文档，记录 CBoard 订阅代码复用、安全修复、官方依据、跨端行为和真实支付缺口。

### 2026-07-22 21:45:08 | Codex（GPT-5）

- 修正取消订阅的有效期判断：到期前保留访问，到期后允许重新选择；补充回归并把证据更新为聚焦 `17 passing`、无数据库全量 `298 passing`。
- 通过 GitHub REST API 在线核对 [picinterpreter issue #1](https://github.com/picinterpreter/picinterpreter/issues/1)：当前路线图要求 Token 计量/限流/月额度、手机号验证、后端豆包语音和自定义图片服务器存储，但没有要求当前阶段实现微信支付。

### 2026-07-22 22:02:49 | Codex（GPT-5）

- 在控制器增加管理员删除纵深校验；普通用户即使绕过 Swagger scope 也不会触发数据库删除。
- Android 交易改为有界规范化，保留 Google Play 服务端验证所需 token，但不把 token 暴露给客户端；增加 64 KiB receipt、4096 字符 token、服务端产品绑定和跨订阅者 transaction ID 重放拒绝。
- 修正 Swagger 交易请求体曾误挂到无关端点的问题，并以契约测试锁定只允许 `/subscriber/{id}/transaction` 使用；证据更新为聚焦 `22 passing`、API 全量 `303 passing`、Swagger `0 errors`。

## 2026-07-23 08:19:09 | Codex（GPT-5）

### 意图

修正 CBoard 现有 PayPal helper 与官方 Subscriptions API 之间的真实请求偏差，让套餐同步、订阅详情校验和取消操作继续复用成熟底座，而不是因为 Axios 参数位置或 JSON 包装错误在 sandbox/生产环境静默失败。

### 决策

1. `listPlans()` 继续调用既有 `GET /v1/billing/plans`，但把 `headers` 和 `params` 合并进 Axios 的同一个 request config；保留 page 1、page size 10 和 `total_required=true`。
2. `cancelPlan()` 继续调用既有 `POST /v1/billing/subscriptions/{id}/cancel`，请求体改为官方定义的顶层 `{ reason: "User cancelled" }`，不再发送 `{ data: { reason } }`。
3. OAuth client credentials 缺失时本地失败；token 响应没有非空 `access_token` 时拒绝继续，不再吞掉异常后发送 `Bearer undefined`。
4. 订阅资源 ID 在任何 OAuth 或 provider 调用前执行非空、128 字符上限和 URL 编码，避免无效 ID 消耗 token 请求或改变路径。
5. 复用项目已安装的 Axios 与 Nock，不新增 PayPal SDK、依赖、路由、数据表或客户端代码；测试通过 `NO_PROXY` 只隔离官方 sandbox 主机，全程禁止实际网络连接。

### 理由

- [PayPal Subscriptions API](https://developer.paypal.com/docs/api/subscriptions/v1/) 明确列出 `page_size`、`page` 和 `total_required` 为查询参数；Axios 的 GET 只读取一个 config 对象，原实现把 `params` 放在第三个参数中会被忽略。
- 官方取消订阅契约要求 1–128 字符的顶层 `reason`，并在成功时返回 `204 No Content`；多一层 `data` 不符合请求 schema。
- 支付适配器必须失败关闭。缺少凭据或 token 时继续构造 Authorization header，会把配置错误推迟为更模糊的供应商请求，也增加无意义外呼。
- 这是一条对现有成熟代码的薄修复；引入新的支付 SDK、订单系统或客户端状态机不会帮助解决当前请求契约错误，反而扩大高风险范围。

### 证据

- PayPal 官方文档在线核对：计划列表参数为 `page_size/page/total_required`；取消接口为 `POST /v1/billing/subscriptions/{id}/cancel`，JSON body 的必填字段是顶层 `reason`，成功响应为 204。
- 新增 6 条纯离线 helper 测试，覆盖计划查询参数、取消 body、订阅 ID 编码、缺凭据、空 token 和无效资源 ID；Nock 禁止真实网络连接，测试为 `6 passing`。
- PayPal helper、订阅安全、Swagger 与 subscriber 控制器聚焦回归为 `28 passing`。
- `test/controllers/**/*.unit.js` 无数据库全量回归为 `313 passing`；语法、Prettier、目标文件 `git diff --check` 和生产部署示例校验全部通过。
- 仓库级 `git diff --check` 仍由既有 `api/controllers/board.js` 尾随空格拦截；该文件不属于本切片，没有为追求全绿而覆盖并行改动。

### 生效范围

- 生效于 cboard-api 既有 PayPal OAuth、计划列表、订阅详情和取消请求适配层，以及订阅目录同步/用户取消调用这些 helper 的现有路径。
- 不改变套餐目录、价格、用户归属、订阅状态判定、Google Play、App Store、CBoard Web、微信只读状态、患者沟通或 Token 额度。
- 不代表 PayPal sandbox/生产购买已验收，也不包含订单创建、webhook 验签、退款、发票、对账、微信支付或真实商户配置。
- 本轮没有调用 PayPal sandbox 或生产 API，没有真实支付、预览、上传、发布、部署、提交或推送；全程后台执行，没有打开、激活、聚焦、抬升或置顶任何窗口。

## 2026-07-23 12:34:42 | Codex（GPT-5）

### 意图

修复套餐同步只读取 PayPal 第 1 页 10 条计划的遗漏风险，确保继续复用 CBoard 现有套餐同步时，不会因为供应商账户计划数量增加而静默失去 `basePlanId → paypalId` 映射。

### 决策

1. 本节取代 08:19:09 记录中“固定 page 1 / page size 10”的临时行为；`listPlans()` 改用官方允许的最大 `page_size=20`，从 `page=1` 开始读取全部页。
2. 一次列表调用只申请一次 OAuth token，所有分页请求复用同一 Authorization header，不为每页重复获取凭据。
3. 优先使用响应 `total_pages`；供应商未返回该字段时，按“满 20 条继续、短页停止”的兼容规则处理。
4. 最多读取 100 页（2,000 条计划）。官方宣称页数超过边界，或连续满页超过边界时失败关闭，不把部分计划交给订阅同步。
5. 保留首屏响应元数据并聚合 `plans`；缺少有效 `total_items` 时用实际聚合数量，缺少有效 `total_pages` 时用实际读取页数。

### 理由

- [PayPal Subscriptions API](https://developer.paypal.com/docs/api/subscriptions/v1/#plans_list) 规定 `page_size` 范围为 1–20、`page` 从 1 开始，并定义 `total_pages`；固定第一页不是完整的计划目录读取。
- 订阅同步会按 PayPal plan name 映射 Google Play base plan。漏掉后续页不会立即报错，却会把对应 `paypalId` 写成空值，属于比显式失败更难发现的数据完整性问题。
- 继续使用现有 Axios helper 和 Nock 是最薄的复用方式；无需引入 PayPal SDK、队列、数据库或新的分页抽象。
- 有界分页避免供应商异常元数据或持续满页造成无上限外呼；失败关闭可阻止不完整目录继续写库。

### 证据

- PayPal 官方计划列表文档在线核验 `page_size/page/total_required` 请求参数和 `total_items/total_pages/plans` 响应集合。
- PayPal helper 纯离线 Nock 回归 `9 passing`，新增覆盖两页 21 条聚合、单次 token、缺少 `total_pages` 的短页终止，以及 101 页时在第一页后失败关闭。
- 订阅/支付安全聚焦回归 `31 passing`；`test/controllers/**/*.unit.js` 全量无数据库单元回归 `316 passing`。
- helper 与测试语法、Prettier、目标 `git diff --check` 和生产部署示例校验通过；没有访问 PayPal sandbox 或生产网络。

### 生效范围

- 生效于 cboard-api `Paypal.listPlans()` 以及调用它的既有订阅目录同步；计划详情、取消、OAuth 凭据来源和其他供应商路径不变。
- 不改变套餐、价格、权益、订阅购买状态、Web/微信 UI、Google Play、App Store、患者沟通或 Token 额度。
- 不代表真实 PayPal 购买、sandbox、webhook、退款、对账或微信支付已完成；100 页以上目录会明确失败，需先由维护者确认业务规模再调整边界。
- 本轮未执行真实支付、预览、上传、发布、部署、提交或推送；全程后台运行，没有打开、激活、聚焦、抬升或置顶任何窗口。

## 2026-07-23 12:39:45 | Codex（GPT-5）

### 意图

修复 CBoard 套餐同步只读取 Google Play 订阅目录第一页的问题，尤其避免后续页套餐被当成“远端不存在”而从本地目录误删。

### 决策

1. 新增独立 `googlePlaySubscriptionCatalog` helper，复用现有 `googleapis` 客户端，不改变认证、套餐映射、数据库模型或控制器路由。
2. 按 Google 官方契约固定 `pageSize=1000`；首屏不发送 `pageToken`，后续屏把上次响应的 `nextPageToken` 原样作为 `pageToken`，其余参数保持一致。
3. 最多读取 100 页；`nextPageToken` 最大 4096 字符，重复 token、异常 `subscriptions` 结构或超限循环均失败关闭。
4. `syncSubscriptions` 只有在 helper 返回完整聚合目录后才进入保存和删除判断；任意分页异常由既有控制器错误路径返回，不使用部分结果删除本地套餐。
5. 复用纯内存假 `googleapis` client 做离线单元测试，不访问 Google、不增加 Nock 或新依赖。

### 理由

- [Google Play Developer API](https://developers.google.com/android-publisher/api-ref/rest/v3/monetization.subscriptions/list) 明确说明默认最多 50 条、最大 `pageSize=1000`，响应 `nextPageToken` 存在时必须继续请求。
- 原控制器随后会遍历本地订阅，并删除不在 `remoteSubscrs` 中的记录；单页结果不仅漏同步，还会把合法后续页套餐判为已删除。
- 把分页封装为薄 helper 可独立证明 token、上限和响应校验，不需要重写 CBoard 控制器或引入第二套订阅系统。
- token 是不透明值，必须原样传递；重复检测和有界页数用于防止供应商异常造成无限循环。

### 证据

- Google 官方列表文档在线核验 `packageName/pageSize/pageToken` 及 `subscriptions/nextPageToken` 契约。
- 新 helper 离线回归 `4 passing`，覆盖两页聚合、请求参数保持、opaque token 原样传递、重复 token、异常页面、超长 token 与 100 页边界。
- Google Play + PayPal + 订阅安全聚焦回归 `35 passing`；`test/controllers/**/*.unit.js` 全量无数据库单元回归 `320 passing`。
- 新文件 Prettier、三文件语法、目标 `git diff --check` 和生产部署示例校验通过；没有访问 Google Play 或任何真实商店账号。

### 生效范围

- 生效于 cboard-api 管理员套餐目录同步中的 Google Play 订阅列表读取，以及依赖完整远端目录的新增、更新和删除判断。
- 不改变 Google Play 购买令牌验证、PayPal/App Store、套餐价格权益、Web/微信 UI、患者沟通或账号数据。
- 不代表真实 Google Play Console、服务账号、sandbox/测试轨道、购买、退款或对账已验收；超过 100,000 个订阅目录时会失败并需要维护者重新评估边界。
- 本轮没有访问真实 Google、支付、预览、上传、发布、部署、提交或推送；全程后台执行，没有打开、激活、聚焦、抬升或置顶任何窗口。

## 2026-07-23 12:46:10 | Codex（GPT-5）

### 意图

修复远端 PayPal/Google Play 已完整分页后，CBoard 同步仍只拿本地默认 10 条响应做删除比对，以及删除后返回旧分页快照的问题。

### 决策

1. 新增 `subscriptionCatalogReconciliation` helper；远端 Google 目录完整返回后，使用现有 `Subscription.find({})` 读取全部本地套餐，不再让管理员请求的 `page/limit/search` 决定全局删除范围。
2. 在任何删除前一次性验证全部远端 `productId` 和本地 `subscriptionId` 非空且不超过 128 字符；任一异常即失败关闭，确保不会先删一部分再发现目录损坏。
3. 只删除本地存在但完整远端 ID 集合中不存在的套餐；继续复用现有 `findOneAndDelete`，不改变 Mongoose 模型或引入批处理依赖。
4. 删除协调完成后，才调用原 `paginatedResponse` 按管理员请求生成响应；API 响应结构和搜索/分页能力保持不变，但不会再返回已删除记录。
5. 新 helper 用 12 条本地 fixture 证明不会被默认 10 条截断；控制器用 Mockery 证明严格执行“协调后响应”的调用顺序。

### 理由

- `paginatedResponse` 默认 `limit=10`，适合列表展示，不适合作为全局目录同步的事实集合；将展示分页用于删除判断会让第 11 条以后永远不参与协调。
- 原控制器在删除前创建 `localSubscrs` 并原样返回，客户端可能在成功响应中继续看到刚被删除的对象。
- 复用 Mongoose 模型和原分页响应、只提取协调胶水，比修改通用分页 helper 或重写控制器更小，也不会影响其他列表端点。
- 先验证所有 ID 再删除可把数据损坏从“部分执行”收紧为“删除前失败”，符合目录同步失败关闭原则。

### 证据

- 协调 helper 与控制器接线新增 `4 passing`：覆盖 12 条本地目录、第 11 条 stale 删除、远端坏 ID 删除前停止、本地坏 ID 删除前停止，以及协调完成后才生成响应。
- Google/PayPal/订阅安全聚焦回归 `39 passing`；`test/controllers/**/*.unit.js` 全量无数据库单元回归 `324 passing`。
- 新文件 Prettier、相关语法、目标 `git diff --check` 和生产部署示例校验通过。

### 生效范围

- 生效于 cboard-api 管理员 `/subscription/synchronize` 的本地套餐全量比对、stale 删除和成功响应时点。
- 不改变普通 `/subscription/list` 分页、远端供应商读取、购买校验、用户订阅记录、价格权益、Web、微信或沟通功能。
- 不代表真实 Mongo 事务、Google/PayPal 商店或支付验收；逐条删除仍沿用原 Mongoose 行为，生产数据库异常需要运维重试。
- 本轮未访问真实数据库/商店、预览、上传、发布、部署、提交或推送；全程后台执行，没有打开、激活、聚焦、抬升或置顶任何窗口。
