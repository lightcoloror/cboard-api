# 中国大陆手机号验证码登录复用决策

- 记录时间：`2026-07-22 19:34:53`
- 执行工具 / 模型：`Codex（GPT-5）`

## 变动 1：复用 CBoard 账号会话增加手机号登录

- **意图：** 让已经完成手机号归属验证的图语家用户可以使用“手机号 + 短信验证码”登录，同时继续复用 CBoard 的 User、Passport/JWT、Settings、订阅状态和板同步，不建立第二套账号体系。
- **决策：** 在现有短信 challenge 上增加 `registration` 与 `login` 两种 purpose，并新增公开 `POST /user/login/phone`。验证码确认后签发与手机号和 purpose 绑定的短期一次性令牌；登录端点原子消费令牌、查询现有 User，再调用与密码登录相同的会话完成函数，返回相同的 JWT、用户、Settings、订阅和 boards 响应。
- **理由：** CBoard 的成熟账号和数据同步是本 fork 的技术底座，手机号只是新的认证凭据，不应成为新的用户表、Session 或小程序专用协议。purpose 绑定可防止注册令牌被拿去登录，原子消费可防止重放。
- **证据：** API controller/service/repository 定向回归 `22 passing`；手机号登录覆盖有效会话、令牌消费、未知号码、无效令牌、重复使用及管理员拒绝。相关文件通过 Node 语法、Swagger 加载、Prettier 和本轮文件差分检查。
- **生效范围：** `cboard-api` 的中国大陆普通用户短信登录。旧邮箱密码、Google/Facebook/Apple、注册短信确认、Settings 与板同步协议保持兼容；不包含短信找回密码、国际号码或新的 Session 实现。

## 变动 2：未知手机号和高权限账号采用安全边界

- **意图：** 防止手机号登录接口泄露账号是否存在，并避免短信成为管理员唯一认证因素。
- **决策：** 未注册手机号仍可进入有界短信 challenge，但在消费已确认令牌后只返回通用 `PHONE_LOGIN_FAILED`；无效、过期、未知和不允许登录的账号不使用可枚举差异文案。`role === admin` 的用户不能使用短信登录，仍使用密码或既有 OAuth。
- **理由：** OWASP 建议认证与找回流程使用一致响应并为高权限账号采用更强认证。若在发码阶段直接暴露“号码未注册”，会形成账号枚举；若管理员只凭短信登录，SIM 换卡和短信劫持风险会放大权限后果。
- **证据：** controller 单元测试覆盖未知号码的统一失败、一次性令牌消费和管理员拒绝；发送和确认继续受 60 秒重发、手机号日限、IP 小时限、五分钟过期和最多五次尝试保护。
- **生效范围：** 公开短信登录链及管理员认证边界。普通用户密码/OAuth 仍可使用；管理员数据和角色模型不变。本决策不声称短信是多因素认证。

## 变动 3：Web 与微信复用同一认证能力和同步闭环

- **意图：** 让 CBoard Web 与图语家微信小程序都能使用手机号登录，并在成功后进入完全相同的账号设置、板和沟通记录同步链。
- **决策：** Web 登录页增加密码/短信模式，复用公共 phone-verification action；微信账号页增加邮箱登录/短信登录/注册三种模式，复用同一 `CboardAccountPort`、倒计时、challenge 和一次性令牌。两端都读取公开 `phoneLoginAvailable`，能力未配置时保留密码登录和本地沟通，不伪装可用。
- **理由：** 认证差异只应存在于“如何取得会话”之前；成功后的 session 保存、Settings、boards 和本地/云合并若复制两套，容易产生数据分叉。能力探测和安全降级也能保证短信供应商故障不阻断核心双向沟通。
- **证据：** Web API/actions/UI 定向 `4 suites / 61 tests / 1 snapshot`，production build 成功；微信账号与同步相邻回归 `5 files / 41 tests`，TypeScript、完整 ESLint、`186 app files / 29 CBoard core files` 边界检查和 production build 通过。微信主包 `1,249,564 B`，距 1.5 MiB 建议线保留 `323,300 B`；所有分包低于建议线。
- **生效范围：** CBoard Web 登录页、图语家微信 management 账号页、既有账号 session 与同步流程。游客、本地离线沟通和旧 API 继续安全降级；不新增 React DOM 到微信，也不把 Material UI 搬入小程序。

## 变动 4：明确复用开源方案而不替换认证内核

- **意图：** 遵守“优先复用，不自行研发”的原则，同时避免为了一个登录方式引入互相冲突的第二套认证基础设施。
- **决策：** 研究并对照 Better Auth phone-number plugin、SuperTokens passwordless OTP 和 OWASP 认证指引；不把 Better Auth 或 SuperTokens 嵌入当前 fork。继续复用腾讯云官方短信 SDK、`rate-limiter-flexible`、CBoard User/JWT/Settings/boards，以及既有一次性 HMAC challenge，只新增 purpose 和平台胶水层。
- **理由：** Better Auth 与 SuperTokens 都能提供成熟 OTP，但集成会要求新 schema、Session 和认证路由，并与 CBoard 既有 Passport/JWT/Settings 同步重叠。当前实现复用的成熟组件已经覆盖短信发送、原子限流和 CBoard 会话，替换内核的迁移风险大于收益。
- **证据：** 官方参考：[Better Auth phone number](https://better-auth.com/docs/plugins/phone-number)、[SuperTokens passwordless](https://supertokens.com/docs/authentication/passwordless/introduction)、[SuperTokens OTP 定制](https://supertokens.com/docs/authentication/passwordless/customize-the-otp)、[OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[OWASP MFA](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)。本轮未新增认证框架依赖。
- **生效范围：** 当前 CBoard fork 的手机号登录架构选择。若未来 upstream 改用统一认证框架，应重新评估迁移，而不是长期维护并行 Session。

## 变动 5：验证证据和发布边界

- **意图：** 区分“代码与构建闭环”和“真实生产运营验收”，避免把尚未完成的外部条件写成已完成。
- **决策：** 以定向测试、静态检查、Web/微信生产构建作为本轮工程证据；三端全量测试在当前高负载机器上分别运行较长时间但未在设定时间边界内返回汇总，因此不声明全量通过。真实短信、Mongo、公网 HTTPS、微信合法域名和物理手机登录留作部署验收门。
- **理由：** 已通过的窄验证可以证明新增路径，但不能替代真实供应商和全量回归。诚实记录残余风险比沿用变更前的全量基线更可靠。
- **证据：** API `22 passing`；Web `4 suites / 61 tests / 1 snapshot` 与 production build；微信 `5 files / 41 tests`、TypeScript、ESLint、边界检查和 production build。三端全量命令只终止本轮精确 PID，没有批量终止或影响无关 Node 进程。
- **生效范围：** 本轮验收声明和后续发布检查。生产必须配置腾讯云 SMS、至少 32 字节的 `PHONE_VERIFICATION_HASH_SECRET`，并确认公开配置返回 `phoneLoginAvailable: true`。部署会使旧的无 purpose challenge 最多在五分钟后自然失效；旧账号若未绑定手机号，继续使用密码/OAuth。

## 当前状态

手机号登录已形成可审查的 API、CBoard Web 与微信小程序工程闭环，但尚未提交、推送、部署、预览、上传或发布，也没有发送真实短信。全过程只使用后台命令和文件补丁，没有打开、激活、聚焦、抬升或置顶任何窗口。
