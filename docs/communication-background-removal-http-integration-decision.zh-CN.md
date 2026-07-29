# 通信增强去背景真实 HTTP 联调决策

## 状态

- 决策状态：已生效
- 最后更新：2026-07-29 01:53:50
- 执行工具 / 模型：Codex（GPT-5.6）
- 关联工程：`cboard-api`、CBoard Web、图语家微信小程序、issue #82

## 意图

在既有 provider 单元测试、双端 UI 和本地 rembg adapter smoke 基础上，补齐普通 CBoard 用户真实登录、multipart 上传、Swagger 角色校验、provider 调用、透明 PNG 校验和响应回传的完整服务端证据。

## 决策

1. 继续复用既有 `/gpt/communication/background-removal`、Bearer 认证、Swagger `user/admin` scope、内存 multipart、`communicationBackgroundRemovalProvider` 和透明 PNG 校验，不新增上传服务、图片数据库、客户端密钥或第二套协议。
2. 固定审查官方 `danielgatis/rembg v2.0.75` 提交 `7b8de60ef9fc225af1768d81aa09da29db22a355`，在一次性 Python 3.11 环境真实启动官方 HTTP server；历史 PyPI `2.0.76` 记录保留，但因当前官方 Git 没有对应 tag，不把其冒充为源码审查提交。
3. 新增显式环境门控的隔离 Mongo + 真实认证 HTTP + Nock provider 集成测试；默认单元测试不依赖 Docker、模型或公网。
4. 合成 provider 域名只在测试进程中追加到现有 `NO_PROXY/no_proxy`，避免用户本机代理绕过 Nock；不覆盖或修改生产代理配置。

## 理由

- provider 单元测试绕过了真实认证与 Swagger，直接 adapter smoke 又绕过了账号和控制器，两者都不能证明普通用户真正能使用该路由。
- 官方 rembg 全量测试会下载并运行 15 个模型，不适合作为日常 API 质量门；固定源码、启动官方 server、运行一个真实官方 fixture，再用轻量确定性 provider 检查认证 HTTP 链，可以同时保留来源证据和可维护性。
- 原始家庭文件名不应发送给 provider；复用现有中性 `communication-image.jpg` 比在测试中要求原名更符合隐私边界。
- 匿名请求返回 403 是 CBoard 当前全局 Bearer 中间件语义，本轮只验证其在 provider 前拒绝，不另行改变全站认证状态码。

## 证据

- 官方 rembg `v2.0.75` 源码工作树干净；CLI 在显式 `NUMBA_CACHE_DIR` 后成功运行，官方 HTTP `/openapi.json` 返回 200。
- 官方 server 使用 `u2netp` 处理自带 `car-1.jpg`，输出真实 `480x360 / 82,754 B` PNG，`hasAlpha=true`，alpha 范围 `0-255`。
- cboard-api 现有 adapter 再调用同一官方 server 默认模型，输出 `480x360 / 78,560 B` PNG，SHA-256 `46854ef1a07f8411fef89b2eadff905bc47712c1ded4e997d7f082fb2ffe6302`，`sourceStored=false`、`originalRetained=true`，耗时约 14 秒。
- 真实认证 HTTP/Mongo 集成 `2/2`：匿名 403 且 provider 未调用；普通 `user` 上传真实 JPEG 后，provider 收到 `file` 与中性文件名，API 返回逐字节相同的透明 PNG 候选。
- cboard-api 全量单元 `376/376`、Prettier 全通过。

## 生效范围

- 生效：cboard-api 去背景可选集成命令、普通用户认证 multipart 证据、provider 文件名隐私断言和 issue #82 覆盖矩阵状态。
- 不变：Web/微信现有单次授权、原图保留、人工预览确认、失败回退、草稿文件清理、默认板、matcher、分词、语音和同步协议。
- 未证明：生产 rembg/remove.bg 部署、公网 HTTPS、微信合法域名、家庭成员和常见物体主体完整度、低端设备耗时、生产并发和物理真机体验。
- 操作边界：本轮未使用 Computer Use，未打开、聚焦、抬升或置顶微信开发者工具，未预览、上传、发布、部署、提交或推送。
