# 腾讯云粤语一句话识别服务端接入与组合验收

- **记录时间：** 2026-07-29 08:35:16
- **执行者：** Codex（GPT-5.6）

## 意图

把图语家粤语录音能力中的腾讯云 `16k_yue` 路径从 provider 单元测试推进到 CBoard 普通用户认证、Swagger multipart、官方 SDK TC3 签名、Mongo 账号和私密可编辑转写的完整工程证据，同时保留火山引擎可选路径和人工最终修正权。

## 决策

1. 继续复用 `tencentcloud-sdk-nodejs-asr@4.1.266`、现有认证 `/gpt/communication/dialect-asr`、中性 provider factory、音频白名单、3 MiB/60 秒产品边界和两端现有 adapter，不新增客户端接口或自研签名代码。
2. 复用源码账本中已安装、构建并审查的腾讯官方 SDK 单仓；当前锁定的 ASR 拆包通过运行时实例化和真实 TC3 请求进一步验收，不重复克隆同一仓库。
3. 新增显式环境门控的隔离 Mongo + Nock 组合门。Nock 只替代收费公网响应，官方 SDK、TC3-HMAC-SHA256、生产认证、Swagger、multipart、音频校验、provider 和控制器均真实执行。
4. 按官方 `SentenceRecognitionRequest.Data` 注释，在腾讯 provider 内增加 Base64 编码后 3 MiB 预检；火山路径继续维持自身格式与上限，不被收紧。

## 理由

- 方法 stub 无法证明 SDK 版本、TC3 action/version/credential scope、JWT 角色或真实 multipart 组合正确。
- 腾讯官方类型明确要求 Base64 后的 `Data` 不超过 3 MB。旧代码只限制编码前 3 MiB，接近上限的原始文件会膨胀到约 4 MiB并在供应商端失败；本地预检可以给出稳定 413 且避免无效外部请求。
- 同一腾讯官方 SDK 源码已经因短信功能完成拉取、安装和构建。复用该来源并验证当前 ASR 拆包，比再次克隆或自行实现 TC3 签名更符合底座复用原则。
- ASR 可能误识别。返回文字继续可编辑且禁止自动触发分词或图片匹配，网络失败不阻断文字输入和本地图板。

## 证据

- 官方 SDK 单仓：<https://github.com/TencentCloud/tencentcloud-sdk-nodejs>，本地固定提交 `3d3fe1bbd5fd293a938f535619d7246caf7ca870`，此前已完成依赖安装、CJS/ES 构建和目标产品测试。
- 当前运行依赖 `tencentcloud-sdk-nodejs-asr@4.1.266` 已成功实例化 `asr.v20190614.Client` 与 `SentenceRecognition`，其编译源码明确记录 60 秒、3 MB、`16k_yue`、支持格式和 TC3 v3 签名要求。
- 认证 HTTP/Mongo 组合门 `2/2`：匿名 multipart 返回 403 且没有 provider mock；普通用户注册、激活、登录后返回 200，Nock 观察到 `SentenceRecognition`、版本 `2019-06-14` 和 `TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/...`。
- 上游 JSON 与生产请求完全一致：`16k_yue`、本地数据源、MP3、原始字节长度、Base64 数据、数字转换和不过滤标点；响应不返回 RequestId 或凭据，带 `no-store, private` 与 `nosniff`，音频不落库。
- 编码后超限单元断言证明 provider 调用数为 0；ASR/provider/controller 聚焦 `31/31`，cboard-api 全量单元 `377/377`，Prettier 和差分检查通过。

## 生效范围

- 生效于部署方选择 `COMMUNICATION_DIALECT_ASR_PROVIDER=tencentcloud` 后的服务端录音识别、编码后大小校验和可选集成验证命令。
- 不改变 CBoard Web、微信小程序、火山 ASR、WechatSI、录音 UI、人工文字修改、粤语文字规范化、分词、matcher、图片或历史。
- 没有真实腾讯云凭据、收费请求、患者录音、公网部署或物理手机，因此不证明服务开通、真实粤语准确率、延迟、费用、弱网和供应商数据治理已经通过。
- 本轮未使用 Computer Use，未打开、聚焦或置顶微信开发者工具，未预览、上传、发布、部署、提交或推送。
