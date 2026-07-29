# 图语家开源语音能力复用评估

## 更新记录

- 2026-07-23 00:14:04 | Codex（GPT-5）| 建立微信语音活动反馈、CBoard 原生离线识别和服务端开源 ASR 的复用边界。

## 结论

当前不在微信同声传译识别期间并发启动第二个 RecorderManager，也不把文字回调伪装成实时音量波形。微信端继续显示诚实的“识别活动”状态；CBoard Web 继续在浏览器允许时使用 Web Audio 的真实 RMS；CBoard Cordova 原生壳继续优先复用现有系统级离线识别插件。

sherpa-onnx 是值得保留的 Apache-2.0 候选，但现有中文/粤语模型约为 226–234 MB，不适合打入微信小程序代码包。若以后需要自托管识别，应把官方 sherpa-onnx 作为独立服务或原生壳能力评估，而不是复制没有明确许可证的第三方 FastAPI/WebSocket 包装仓库。

## 复用候选

| 候选 | 当前判断 | 适用位置 |
| --- | --- | --- |
| [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0、活跃、覆盖 ASR/TTS/VAD；模型过大，不进入微信包 | CBoard 原生壳或未来私有服务端 |
| 本地 cboard-speech-recognition fork | MIT；已经支持 Android 12+/iOS 13+ 系统级识别 | CBoard Cordova 原生壳，当前优先 |
| 本地 cboard-speech-tts | CBoard 既有 Cordova TTS 插件 | CBoard Cordova 原生壳 |
| 微信同声传译插件 | 已在真机恢复识别与播报；中间文本回调不等于音量帧 | 微信小程序在线语音 |
| ruzhila/voiceapi | GitHub API 未声明许可证，不能复制代码进入公开 fork | 仅参考协议形状 |
| hfyydd/sherpa-onnx-server | GitHub API 未声明许可证，维护与测试证据较弱 | 不复制 |
| cboard-ai-engine | 旧 CBoard GPL 代码；上游仓库已不可访问，英文板、旧 OpenAI SDK 和脆弱输出解析与当前中文安全链冲突 | 只选择性复用已验证的 ARASAAC 搜索顺序 |

## 微信活动反馈边界

- WechatSI 的 onRecognize 只在插件产生新的中间识别文本时回调，存在网络和识别延迟。
- Taro/微信 RecorderManager.onFrameRecorded 只有在应用自己启动录音并设置 frameSize 时才提供音频帧。
- WechatSI 已经占用识别录音；同时再启动全局 RecorderManager 可能争抢麦克风、破坏已经恢复正常的识别。
- 因此当前 UI 明确写为“监听状态，不是音量波形”，静音时不变化；不以固定动画伪造实时波形。

## 变动说明

- **意图：** 在继续复用成熟语音能力的同时，修复“活动指示看起来像延迟波形”的认知风险，并避免为了视觉即时性破坏真机识别。
- **决策：** 微信保留 WechatSI 中间文本驱动的活动状态，不并发录音；CBoard 原生壳继续复用 MIT 系统识别插件；sherpa-onnx 仅进入未来原生/服务端候选清单；无明确许可证的第三方包装代码不复制。
- **理由：** 微信插件没有暴露可供当前识别会话消费的实时 PCM/RMS；中文 sherpa 模型远超小程序包体边界；现有 Cordova 插件已提供更低维护成本的系统离线路线。
- **证据：** 当前小程序 recognitionPort 只消费 WechatSI onRecognize/onStop；ReceiverWorkspace 明确标注活动状态语义。官方 Taro RecorderManager 文档说明音频帧依赖应用自行录音；sherpa-onnx 官方模型页列出的 SenseVoice int8 与 Paraformer int8 约为 226–234 MB。CBoard 与 API 已分别包含可验证的 Web Audio RMS、Cordova 系统识别和供应商 ASR 适配层。
- **生效范围：** 微信语音状态展示、CBoard 原生语音路线及未来服务端 ASR 技术选型；不改变现有 WechatSI、腾讯/火山 ASR、TTS、分词、图文匹配或患者表达语义。本次不新增依赖、provider 或模型，不预览、上传、发布、部署、提交或推送，也不打开、激活、聚焦、抬升或置顶任何窗口。

## 参考资料

- [sherpa-onnx 官方仓库](https://github.com/k2-fsa/sherpa-onnx)
- [SenseVoice 预训练模型与体积](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)
- [Paraformer 预训练模型与体积](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-paraformer/paraformer-models.html)
- [Taro RecorderManager](https://nervjs.github.io/taro/docs/apis/media/recorder/RecorderManager/)

