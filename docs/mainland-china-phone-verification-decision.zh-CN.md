# 中国大陆手机号短信验证决策

- 记录时间：`2026-07-22 10:28:30`
- 执行工具 / 模型：`Codex（GPT-5.6）`

## 意图

补齐原 PicInterpreter issue #1 中“注册时验证手机号归属”的缺口，让 CBoard Web、微信小程序和未来客户端继续复用同一账号后端；同时把供应商密钥、验证码、限流和一次性令牌留在可信服务端，不在客户端复制认证逻辑。

## 决策

- 直接复用腾讯云官方 Apache-2.0 产品级 Node SDK `tencentcloud-sdk-nodejs-sms@4.1.240` 的 `sms.v20210111` 客户端，不自行实现签名、HTTP 重试或短信协议。
- 继续复用 cboard-api 已引入的 `rate-limiter-flexible@11.2.0` Mongo adapter；重发间隔 60 秒、同手机号每天 2 次、同 IP 每小时 20 次，键只保存 SHA-256 摘要。
- 公开 `GET /user/phone-verification`、`POST /user/phone-verification` 和 `POST /user/phone-verification/confirm`；注册仍复用 `POST /user`，只额外接受一次性 `phoneVerificationToken`，不建立小程序专用账号 API。
- 验证码为六位数字，challenge 五分钟过期、最多尝试五次；确认后签发与手机号绑定的 64 位随机令牌，十分钟过期且注册时原子消费一次。
- 数据库只保存 HMAC 后的手机号、验证码和令牌，以及脱敏手机号；原始验证码、原始手机号和原始 IP 不进入 challenge 或限流记录。HMAC 密钥必须独立配置且至少 32 字节。
- 腾讯云凭据、短信签名、模板 ID 和模板变量只在服务端环境中配置；模板变量白名单仅允许 `code` 与 `minutes`。生产要求验证时配置缺失必须失败关闭。
- Web 与微信只读取公开能力配置、请求 challenge、人工输入验证码并取得内存令牌；修改手机号立即清除 challenge 和令牌。微信按照服务端返回值显示重发倒计时。

## 理由

腾讯云官方 SDK 已经维护鉴权、请求模型和供应商错误，现有限流库已提供 Mongo 原子计数；复用两者比自研短信客户端和分布式限流器更可靠。一次性短期令牌把短信确认与邮件激活注册解耦，又不需要把验证码或供应商能力写进 User。服务端失败关闭可以防止“生产要求验证、配置却丢失”时静默绕过。

## 证据

- 官方参考：[腾讯云短信 Node.js SDK](https://cloud.tencent.com/document/product/382/56060)、[短信轰炸防护](https://cloud.tencent.com/document/product/382/13303)、[官方 Node SDK 仓库](https://github.com/TencentCloud/tencentcloud-sdk-nodejs)。
- cboard-api 新增 provider、repository、service、Mongo 限流、Swagger、生产环境模板和 controller 测试；全部无数据库 controller/route 回归 `221 passing`，生产模板校验与 `yarn install --frozen-lockfile --ignore-scripts` 通过。
- CBoard Web 全量 `189 suites / 1238 tests / 72 snapshots` 与 production build 通过；共享手机号验证纯核心由 Web 与微信共同消费。
- 微信全量 `64 files / 278 tests`、质量门 `7/7`、TypeScript、ESLint、`184 app / 29 core` 边界与 production build 通过。主包 `1,249,564 B`，低于 1.5 MiB 建议线并保留 `323,300 B` 余量。
- 本轮未配置真实腾讯云密钥、签名或模板，未发送短信、未产生短信费用；因此证据是工程闭环和失败关闭，不是真实运营验收。

## 生效范围

适用于本 fork 的中国大陆手机号注册验证、CBoard Web 注册页、微信 management 账号页、cboard-api User 注册和生产部署模板。旧账号、第三方登录、邮箱注册和未要求手机号验证的 upstream 客户端保持兼容。不包含手机号登录、短信找回密码、国际号码、短信套餐购买、签名/模板审核、真实手机收码、公网 HTTPS、微信合法域名、隐私政策或反轰炸控制台配置。未提交、推送、部署、预览、上传或发布；未打开、聚焦、抬升或置顶任何窗口。

## 2026-07-22 19:34:53 | Codex（GPT-5）

- **意图：** 在不改变既有注册短信行为的前提下，让同一 challenge 基础设施安全支持普通用户手机号登录。
- **决策：** challenge 增加 `registration` / `login` purpose 并参与查询、确认、消费；缺省仍为 `registration`，保持旧客户端兼容。手机号登录只消费 purpose=`login` 的一次性令牌。
- **理由：** purpose 绑定可防止跨流程重放；缺省注册值可以避免已经接入的 Web/微信注册客户端因协议扩展失效。
- **证据：** API service/repository/controller 定向回归合计 `22 passing`；Web 注册 action 继续默认发送 registration，微信显式按页面模式发送 purpose；手机号登录完整决策见 `mainland-china-phone-login-decision.zh-CN.md`。
- **生效范围：** 原文“不包含手机号登录”仅描述 `2026-07-22 10:28:30` 时点；当前普通用户手机号登录代码已补齐。短信找回密码、国际号码和真实生产收码仍不在完成范围内。未提交、推送、部署、预览、上传或发布；未打开、聚焦、抬升或置顶任何窗口。

## 2026-07-22 20:38:50 | Codex（GPT-5）

- **意图：** 在继续复用同一短信验证基础设施的前提下，补齐普通用户忘记密码后的号码归属证明与安全重置。
- **决策：** purpose 扩展为 `registration` / `login` / `password-reset`；第三种令牌只能由手机号重置端点原子消费，不能用于注册或登录。公开配置增加 `phonePasswordResetAvailable`。
- **理由：** 三个流程都依赖号码归属，但权限和后果不同；purpose 绑定可防止跨流程重放，复用 challenge 又避免复制验证码、供应商和限流实现。
- **证据：** Swagger 已加载三个 purpose；短信 service、route、注册、登录、密码重置与 JWT 失效聚焦回归 `41 passing`。完整安全决策见 `mainland-china-phone-password-reset-decision.zh-CN.md`。
- **生效范围：** 原文“不包含短信找回密码”只描述早期时点；当前 API/Web/微信工程闭环已补齐。真实腾讯云收码、公网 HTTPS、微信合法域名、物理手机恢复和国际号码仍待验收或实现。未提交、推送、部署、预览、上传或发布；没有打开、激活、聚焦、抬升或置顶任何窗口。

## 2026-07-29 02:23:05 | Codex（GPT-5.6）

- **意图：** 把此前主要由单元测试证明的手机号注册验证推进到真实 Swagger HTTP、腾讯云官方 SDK、Mongo challenge 和 CBoard 临时用户注册的组合链，确认“可配置”不是“已经联通”的误判。
- **决策：** 固定 npm 实际依赖 `tencentcloud-sdk-nodejs-sms@4.1.240` 的官方 Git `gitHead=3d3fe1bbd5fd293a938f535619d7246caf7ca870`，在本地克隆并运行该提交；新增环境显式门控的 `verify:phone-verification-http-mongo`。测试只用 Nock 替代 `sms.tencentcloudapi.com` 的公网响应，TC3 签名、SDK 请求模型、Swagger、controller、service、repository、Mongo 和注册 controller 均走生产代码。
- **理由：** provider mock 无法证明官方 SDK 真正发送的 action、版本、签名头和 JSON 参数，也无法证明一次性 token 会被既有邮件激活注册原子消费；直接发送真实短信又需要已审核签名/模板、真实密钥和费用。官方 SDK + 本地供应商响应是当前最小、可重复、无费用的可信工程门。
- **证据：** 官方 monorepo 在固定提交上 `npm ci` 安装 408 packages、CJS/ES build 通过、官方 `sms.v20210111` 测试 `19/19`；npm SMS 包标记为 `4.1.240`，该 Git 提交根包为 `4.1.239`，两者按 npm `gitHead` 关系记录而不虚构 tag。组合测试观察到 `TC3-HMAC-SHA256`、`SendSms`、`2021-01-11`、E.164 手机号、模板变量 `[六位码, 5]` 和 challenge `SessionContext`；错误码为 400，正确确认后首次注册为 200，删除临时用户后重放同一 token 为 403。该门连续三次通过，最终 `1 passing` 约 2 秒；API 无数据库单元基线仍为 `376 passing`，Prettier 通过。标准 `npm test` 两次因完整旧套件在 124/364 秒内无终态而未冒充通过。
- **生效范围：** cboard-api 手机注册短信的工程级 provider/HTTP/Mongo 验收、测试命令和来源证据；Web 与微信继续复用既有 challenge/token 协议，无 UI 或业务语义变化。真实腾讯云账号、短信套餐、已审核签名/模板、物理手机收码、运营商到达率、公网 HTTPS、微信合法域名和生产防轰炸仍是外部发布门。本轮没有发送短信、产生费用、提交、推送、部署、预览、上传或发布，也没有使用 Computer Use 或操作任何窗口。

## 2026-07-29 03:08:53 | Codex（GPT-5.6）

- **意图：** 把已经存在的手机号登录和短信找回从 UI、端口与单元测试推进到腾讯云官方 SDK、Swagger HTTP、Mongo、密码哈希和 JWT 撤销的组合闭环，并验证“找回密码后旧登录失效”不是只写在代码里的承诺。
- **决策：** 继续复用同一 `tencentcloud-sdk-nodejs-sms@4.1.240`、challenge repository、purpose 绑定和 `verify:phone-verification-http-mongo`，不新增端点或账号系统。集成门增加 `login` 与 `password-reset` 两种 challenge；真实联调发现 `User.getById()` 的公开序列化删除 `authVersion` 后，最小修复是在认证内部对象上恢复不可枚举版本字段，使中间件可校验而 `/me` 不会泄露。
- **理由：** provider、controller 和 auth helper 分开的单元测试无法发现序列化层把内部撤销版本丢掉；只有“短信登录取得旧 JWT → 短信找回 → 再访问受保护接口”的组合链能证明撤销真实生效。不可枚举字段复用现有版本设计和响应边界，比改变 token、Swagger 或复制认证查询更小且兼容。
- **证据：** 修复前真实 `/me` 在密码重置后错误返回 `200`；修复后旧 JWT 返回 `403`，旧密码返回 `401`，新密码和新 JWT 返回 `200`。登录 token 用于重置返回 `400`，登录/重置 token 重放分别返回 `401/400`；Mongo 两条 challenge 均已消费且不含原始手机号。组合门 `2/2`，API 单元 `376/376`，CBoard 账号定向 `4 suites / 74 tests / 1 snapshot`，微信账号端口 `21/21`，微信 TypeScript、ESLint、production build、`10/10` 产物门和 CBoard 隔离 production build 均通过。
- **生效范围：** 中国大陆普通用户手机号登录、短信找回、旧 JWT/旧密码撤销及 API 内部认证用户加载；注册、邮箱登录、第三方登录、管理员强认证路径、客户端协议和 UI 不变。真实腾讯云收码、国际号码、公网 HTTPS、微信合法域名、物理手机账号恢复和生产反轰炸仍待外部验收。本轮没有发送短信、产生费用、提交、推送、部署、预览、上传或发布，也没有使用 Computer Use、开发者工具或任何窗口操作。
