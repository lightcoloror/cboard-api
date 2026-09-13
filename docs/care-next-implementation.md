# 图语家统一账号、患者协作与周额度

更新时间：2026-09-13 20:14:08（Asia/Shanghai）
实现与整理：Codex（GPT-6 Astra）

## 启用与交付范围

继续使用 User、DeviceSession、Communicator 和现有 CareProfile。服务端同时开启 `CARE_COLLABORATION_ENABLED=true`、`CARE_NEXT_ENABLED=true` 才进入本轮完整流程；Web、小程序分别使用已有 `REACT_APP_CARE_COLLABORATION`、`TARO_APP_CARE_COLLABORATION` 构建开关。默认配置不会发放任何真实权益。上线应协调两端版本与服务端开关，不能只更新某一端。

本轮覆盖使用关系、个人收藏、家庭共享、设备离线归档、家庭权益、家庭/机构额度账户。真实购买、微信快捷登录、机构管理后台、公开发布和真实患者迁移均不在本轮。

## 五阶段对应

1. `carePolicy`、`careSubscription`、CareService context/relationship/administrator：患者默认表达，家属默认接收。角色不授予权限；付款人、管理员、操作者、患者分开。首次订阅管理员可指定，续费保留现有管理员。到期仍允许撤销邀请和撤销成员访问。
2. `careFavorites`：个人原收藏保存在账号加密文档内，按患者关联；不进入全体成员快照。患者收藏/显式分享进入家庭档案。家庭共享与已有公共模板接口保持独立。管理员更新共享与关联原收藏是两个独立版本目标，可显示部分失败。修改记录只包含操作元数据。
3. Web CareHome、共享 careSync/careProjection、Taro careWorkspace：实际表达、接收、图库和收藏使用同一档案。队列与缓存按账号/家庭/档案隔离。前台 30 秒、联网、回前台、保存触发。幂等 ID、版本冲突、删除标记和撤权检查沿用服务端合同。
4. careDeviceArchive：稳定患者/资源 ID、校验和、媒体、待提交操作与冲突；密码加密复用已有 XChaCha20-Poly1305/scrypt 模块。空白设备可以从协作设置页离线恢复，然后进入现有表达/接收流程。没有登录令牌、成员授权或管理员资格；登录后必须明确选择同一患者导入并重新鉴权。旧备份先核对来源，不自动绑定或上传。
5. careBudget/careAiMetering：每个额度账户使用一个加密 Mongo 文档作为 CAS 原子边界，余额、委托上限和消费回执一起提交。周额度按首次生效锚点每 7 天重置，不结转。另购包 30 天，体验包与初始包独立配置。家庭订阅到期后有 30 天只读下载期，不自动删除云数据。

## 接口摘要

Swagger 继续承载 `/care` 接口，不新增账号体系。

| 接口 | 关键参数与结果 |
| --- | --- |
| GET/PUT `/care/context` | 当前账号选择的 profileId；返回前重新核对权限 |
| POST `/care/profiles/{id}/commands` | relationship、shareFavorite、put/delete、invite/grant；写入带 operationId/baseVersion |
| GET `/care/profiles/{id}/entitlements` | active/download_grace/inactive、syncWrite/download/ai、expiresAt/downloadUntil、本地使用与导出 |
| GET/POST `/care/profiles/{id}/favorites` | 仅当前账号在该患者下的原收藏；action、resourceId、operationId、baseVersion、value |
| POST `/care/profiles/{id}/favorite-original` | 管理员；sharedId/sharedVersion、原收藏 baseVersion；目标从服务端共享关联取得 |
| POST `/care/profiles/{id}/administrator` | 当前家庭管理员指定已加入成员；operationId 幂等；续费不触发交接 |
| GET `/care/funding?profileId=...` | 仅本人有资料权限且有额度授权的来源、周期、额度包、委托上限、待对账请求 |
| POST `/care/funding/{id}/delegation` | 额度管理员；member、profileIds、每周 limit、revoked；不授予资料访问权 |

AI 请求须带 `X-Care-Profile-Id`、`X-Care-Funding-Id`、`Idempotency-Key`。服务端先检查资料授权、家庭权益、所选来源和委托，再预留。不会自动换扣另一个家庭或机构。正常的本机识别、播报、规则匹配不调用计量接口。

业务错误明确区分 LOGIN_REQUIRED/401、PROFILE_ACCESS_DENIED、SUBSCRIPTION_EXPIRED、DOWNLOAD_PERIOD_ENDED、AI_QUOTA_EXCEEDED、DELEGATED_QUOTA_EXCEEDED、版本冲突和存储错误。订阅/登录问题保留合法本地内容；真正撤权锁定档案入口，不声称能即时清除离线设备。

## 历史与偏好

普通历史只保留本机最近 50 条完成的表达/接收记录。原接收记录上传接口在新流程返回 HISTORY_LOCAL_ONLY；旧设置写入沟通包返回 USE_PATIENT_SYNC。升级客户端的设置同步、接收记录同步、登录合并和 AI 请求构造均排除普通历史。旧云历史未自动删除。首次收缩旧本地集合前保存本机恢复副本。

AI 只提交本次选图/文本及用户选定的当前场景，不自动附带过往对话或评价。收藏独立于历史保留，不再按历史数量裁剪。

共享偏好白名单：language、speechRate、preferredWords、fontSize、cardDensity、personalImagePreferences。字号为 normal/large/extra-large，图卡密度为 2/3/4；两端将默认值映射为各平台显示设置，本机可覆盖。具体声音、音量、使用次数和缓存留在设备。

## 媒体与恢复

媒体写入采用现有受限存储适配器和服务端认证加密。校验成功、登记后才能引用。普通图库媒体按档案授权；`visibility=private` 的原收藏媒体仅上传者或已显式共享的引用可读，其他成员不能凭媒体 ID 下载。个人收藏附件使用保守保留标记防止跨文档并发删除；清理策略应在存储对账后另行配置，本轮不自动回收这些附件。

恢复始终保留资源身份；重复导入按资源/操作 ID 去重。重新联网先鉴权、再读取云版本和删除标记，不用备份复活云端删除内容。公共模板只应用到本地，保留出处，家庭操作不能发布或修改公共模板。

## 额度配置与异常处理

可信配置入口为 `createCareSubscription().activate`、`createCareBudget().provision/renew/addPack`，没有允许客户端自报付款或发放额度的 HTTP 入口。测试脚本有明确的合成权益配置；不得复制成生产商业参数。

`CARE_AI_PRICE_POLICY` 是按 Swagger operationId 索引的 JSON，字段为整数 `reservationUnits`、`fixedUnits`，按 token 计费时另设 `tokensPerUnit`。计量包括句子、分词匹配、在线识别/合成、图片/OCR、元数据和在线去背景。未配置的操作拒绝执行。预留上限须覆盖提供商的请求上限；超出预留不会突破授权自动加扣，会留下待对账记录。

预留后，成功按观察到的用量或配置定额结算；明确的校验/拒绝失败释放。提供商超时、连接中断、5xx 或结算存储故障保留未决回执，不能把“未知”当作未执行后重复调用。设置页显示待对账请求。

对账由可信服务进程在核实提供商结果后调用 `settle(fundingId, actor, requestId, actualUnits, evidenceId)`，证据标识是脱敏工单/回执 ID，不存患者输入。actualUnits 为 0 表示确认释放，不得超过原预留；重复结算数额必须一致。释放只退原额度桶，不把过期余额退到新的一周。不提供普通成员可以自行结算的接口。

原按账号的月 token 限额和月增强点数不再叠加在新流程上。每分钟限流继续作为服务保护，不是订阅计费周期。旧月用量查询提示改查显式额度来源。

## 验收与限制

执行 API 单元测试及 `test/integration/careHttp.mongo.integration.js --next`。隔离脚本覆盖真实 Mongo、真实私有文件写入、密文恢复、HTTP 鉴权与合成 AI 计量；不调用付费 AI，也不触碰生产数据库。

Web 执行共享核心、沟通组件测试与启用新流程的构建；小程序执行类型、单元、lint、架构边界、构建与产物检查。当前开发者工具安装诊断返回 nw_runtime_incompatible，开发者工具场景及真机联网仍未验收。测试通过不等于可公网发布。

所有加密聚合文档当前有 5 MiB 上限，单资源 256 KiB、单图 4 MiB、离线加密归档 20 MiB；达到限制返回明确容量错误。需要规模化长期运行时，再拆分回执/审计存储并配置归档保留策略。本轮没有自动删除任务。
