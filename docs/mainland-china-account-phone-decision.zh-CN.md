# 中国大陆账号手机号兼容决策

- 记录时间：`2026-07-22 08:22:37`
- 执行工具 / 模型：`Codex（GPT-5.6）`

## 意图

复用原 PicInterpreter 已经测试过的手机号规范化、格式校验、唯一性和脱敏规则，为图语家小程序提供账号联系方式；同时不能让这个中国大陆产品约束破坏 CBoard upstream 既有的全球邮箱注册。

## 决策

- `POST /user` 接受可选 `phone`；提供时删除非数字并要求符合 `^1\d{10}$`，未提供时完整保留旧注册流程。
- 创建前同时查询正式 `User` 与邮件激活临时用户，重复号码返回 `409`；User schema 使用 `unique + sparse`，让旧用户和无手机号用户保持兼容。
- User JSON 只输出 `phoneMasked`，格式为 `138****8000`；原始 `phone` 与 password、token 一样在序列化边界删除。
- Swagger 记录可写的可选 `phone` 和只读 `phoneMasked`，不新增图语家专用认证端点。
- 手机号 sparse unique 索引使用字段级显式 `phone_1` 定义，使邮件激活临时模型继承同一索引；同时把 User 加入现有 communication readiness coordinator，创建正式用户索引失败时公开健康状态保持 degraded，而不是继续声明可用。
- 邮件激活临时用户保存时若因并发触发 `phone_1` 的 Mongo `11000/11001`，返回不含数据库细节的 `409`；其他临时用户存储错误返回通用 `500`，不再把原始 Error 作为 `404` 响应。

## 理由

原 PicInterpreter 已有相同规则和单元测试，迁移这段小而明确的业务逻辑比引入短信 SDK、第二套账号表或小程序专用后端更稳。号码格式正确且数据库唯一不等于号码归属已验证；在没有短信供应商、费用、隐私告知和滥用防护决策前，不应声称完成手机验证。

## 证据

- helper、注册 controller 与索引 readiness 定向测试 `15 passing`，覆盖格式错误、规范化、重复检查、邮件激活路径、无手机号兼容、并发初始化、失败重试、正式 User 与临时 User 的 sparse unique 索引、重复键竞态和错误脱敏。
- cboard-api 全部无数据库单元/路由回归 `201 passing`，Swagger 加载、语法、新增文件 Prettier 与差分检查通过；历史 `user.js` 未做全文件格式化，避免覆盖并行变动。
- CBoard Web 与微信客户端都只读取脱敏值；微信 session 会丢弃不符合掩码格式的历史输入。

## 生效范围

适用于本 fork 的本地邮箱注册、邮件激活临时用户、User 模型、公开 User JSON 与现有 `/health` 索引 readiness。第三方登录、旧账号和不发送 `phone` 的 upstream 客户端不变。本决策不包含短信验证码、手机号登录、手机号找回密码、国际号码、公开用户图片上传或商业计费；生产仍需在真实 Mongo 历史数据和并发注册下验收，readiness 不会自动清理既有重复号码。未提交、推送或部署。

## 更新记录

- `2026-07-22 08:41:19`，Codex（GPT-5.6）：补充 User readiness、并发重复键 `409` 与非重复存储错误脱敏；定向 `14 passing`、API 全量 `200 passing`。
- `2026-07-22 09:18:44`，Codex（GPT-5.6）：确认邮件验证库只复制字段配置，因此把 `phone_1` 保持为可继承的字段级命名索引；隔离测试证明正式与临时模型均为 unique + sparse，定向 `15 passing`、API 无数据库全量 `201 passing`。
