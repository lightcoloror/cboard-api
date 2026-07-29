# 中国大陆手机号找回密码与重置安全决策

- 记录时间：`2026-07-22 20:38:50`
- 执行工具 / 模型：`Codex（GPT-5）`

## 变动 1：复用短信 challenge 增加手机号找回密码

- **意图：** 让已经绑定中国大陆手机号的普通 CBoard 用户可以通过短信验证重置密码，同时让 CBoard Web 和图语家微信小程序继续使用同一账号、Settings、图板和同步体系。
- **决策：** 在既有 `PhoneVerificationChallenge`、腾讯云短信 provider、Mongo repository 和限流器上增加 purpose=`password-reset`；确认后签发与手机号和 purpose 绑定、十分钟过期、只能消费一次的随机令牌。新增 `POST /user/store-password/phone`，不新增小程序专用账号服务。
- **理由：** 注册、登录和找回密码都需要证明手机号归属，但三种令牌不能跨流程重放。复用现有 challenge 和 CBoard User 比引入第二套 OTP、User 或 Session 更小、更一致。
- **证据：** Swagger 已真实加载 `registration,login,password-reset` 三种 purpose 和 `resetPasswordWithPhone` operation；API 短信、注册、登录、重置和认证版本聚焦回归 `41 passing`。
- **生效范围：** cboard-api 中国大陆普通用户短信找回密码。未知手机号使用同一有界失败响应；管理员继续使用既有高强度登录/恢复路径。国际号码、管理员短信恢复和真实腾讯云收码不在本变动完成范围内。

## 变动 2：修复既有邮件重置链的安全缺陷

- **意图：** 防止新增短信恢复建立在可绕过的旧密码重置逻辑之上，并避免账号枚举或原始重置令牌泄漏。
- **决策：** `POST /user/forgot` 对已知和未知邮箱统一返回通用成功文案，不再返回 `userid` 或原始 token；数据库只保存 bcrypt 哈希和过期时间。`POST /user/store-password` 现在验证 64 位不透明 token、过期时间和一次性状态，再原子消费记录并保存 bcrypt 密码哈希。密码统一限制为 6 到 128 位。
- **理由：** 原实现没有使用 `bcrypt.compare` 的结果，读取了错误的 token/expiry 字段，也把原始令牌返回客户端；继续复用会形成直接接管账号的风险。OWASP Forgot Password 指引要求通用响应、随机且有时效的一次性 token、安全保存密码，并且重置后不自动登录。
- **证据：** 新增 helper/controller 回归覆盖通用响应、不泄漏 token、错误/过期 token、一次性消费、bcrypt 密码和有界错误；旧集成测试中依赖明文 token 的过时断言已移除。参考 [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)。
- **生效范围：** 既有 CBoard 邮件找回和新短信找回共享密码策略与安全响应。邮件发送后的“密码已修改”通知和应用层邮箱请求限流尚未新增；生产仍应在入口层限流，并在后续补充通知模板。

## 变动 3：重置后撤销旧 JWT 和其他重置入口

- **意图：** 避免攻击者或遗失设备持有的旧 JWT 在密码重置后继续访问账号，也避免旧邮件重置链接再次改写新密码。
- **决策：** User 增加不序列化的 `authVersion`；新 JWT 带当前版本，受保护请求必须与数据库版本一致。邮件或短信重置成功时原子递增版本。短信路径先作废未使用的邮件重置记录，再写入新密码；作废失败时不改变密码。
- **理由：** 密码重置的目的包含恢复账号控制权，仅修改哈希而保留全部旧会话不能完成恢复。先作废邮件令牌可避免“密码已修改但后续作废失败、客户端却收到错误”的半完成状态。
- **证据：** 认证版本测试覆盖新 token、旧 version-zero 兼容和 stale token 拒绝；短信 controller 测试覆盖旧邮件 token 作废失败时 `userUpdate === null`。API 聚焦回归最终为 `41 passing`。
- **生效范围：** 所有由 CBoard API 签发并经过现有认证中间件校验的 JWT。历史无 `authVersion` 用户按 0 兼容；第一次重置后旧 token 失效。不会自动退出纯离线游客，也不改变第三方身份提供商本身的会话。

## 变动 4：Web 与微信复用同一找回契约

- **意图：** 在成熟 CBoard Web 与微信小程序都提供可测试入口，同时不复制后端规则或在客户端保存短信密钥。
- **决策：** Web 现有“忘记密码”对话框保留邮件模式并增加手机号模式；微信 management 账号页增加“手机找回密码”，复用 `CboardAccountPort` 请求、确认和重置接口。两端都要求人工输入两次新密码、读取 `phonePasswordResetAvailable`、修改手机号即清除 challenge，成功后返回登录而不自动取得 session。
- **理由：** 客户端只应编排公开能力和人工输入，账号存在性、token 消费、密码哈希与会话撤销必须在服务端。成功后重新登录符合 OWASP 指引，也复用 CBoard 已有登录/合并流程。
- **证据：** Web 聚焦 `4 suites / 50 tests` 和当前 production build 通过，主 JS gzip `1,674,701 B`；微信全量 `65 files / 289 tests`、TypeScript、ESLint、`186 app / 29 CBoard core` 边界和 production build 通过。
- **生效范围：** CBoard Web Reset Password 对话框和微信 management 账号页。短信服务未配置时保留邮件登录/重置与离线沟通，不显示虚假可用状态。

## 变动 5：坚持成熟组件复用并保留生产验收门

- **意图：** 满足“尽量复用开源和现有工程、不要自行研发”的约束，又避免为了 OTP 替换 CBoard 成熟账号底座。
- **决策：** 继续复用 CBoard User/JWT/Settings、腾讯云官方短信 SDK、`rate-limiter-flexible` Mongo adapter、bcryptjs、Node crypto 和既有 challenge；参考 Better Auth、SuperTokens 与 OWASP，但不引入会产生第二套 schema/Session 的认证框架。
- **理由：** Better Auth 和 SuperTokens 的 OTP 能力成熟，但当前缺口只是 CBoard 认证前的号码证明和恢复胶水；替换内核会扩大迁移、数据兼容和部署成本。现有依赖已经覆盖供应商协议、密码哈希、随机令牌与原子限流。
- **证据：** 本轮没有新增 npm 依赖；微信输出检查为 775 张 CBoard 图片共享一次，主包 `1,249,564 B`、management 分包 `501,244 B`，所有包低于 1.5 MiB 建议线。插件下载体积仍须在上传前用微信官方性能扫描确认。
- **生效范围：** 当前 fork 的密码恢复架构和发布检查。真实腾讯云短信、Mongo、公网 HTTPS、微信 request 合法域名、物理手机收码/重置、邮件通知和入口层滥用防护仍待部署验收或后续补齐。本轮未提交、推送、部署、预览、上传或发布，也没有打开、激活、聚焦、抬升或置顶任何窗口。

## 当前状态

手机号找回密码已经形成 cboard-api、CBoard Web 和微信小程序的可审查工程闭环，并顺带修复旧邮件重置的高风险缺陷；它尚不是生产运营验收完成。

## 2026-07-22 20:44:32 | Codex（GPT-5）：请求级验证边界

- **意图：** 用真实 Supertest 请求再验证旧邮件找回的通用响应，而不是只依赖 controller 单元测试。
- **决策：** 单独运行 `test/controllers/user.js` 中 `POST /user/forgot` 用例；发现本机 Mongo `127.0.0.1:27017` 未运行且已有无关进程占用测试端口 `10010` 后停止，不终止该进程、不擅自启动数据库，也不把用例记为通过。
- **理由：** 环境启动失败不等于功能断言失败，但也不能作为请求级通过证据。保护共享进程和数据库边界比为了绿色结果强行清理环境更重要。
- **证据：** 该命令在 before hook 报 `ECONNREFUSED 127.0.0.1:27017` 与 `EADDRINUSE :::10010`，因此 `0 passing`；同一逻辑的无数据库 controller 安全回归仍为 `41 passing`，Swagger、Web 和微信验证不受影响。
- **生效范围：** 当前验收声明：已证明 controller/契约/客户端/构建闭环，尚未证明本机 Mongo 请求级集成。后续应在隔离测试数据库和空闲端口运行 Supertest，而不是复用生产或共享开发数据库。
