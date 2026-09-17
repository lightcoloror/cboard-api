# 注销任务只读诊断

Updated: 2026-09-18 00:58:00 | Codex (GPT-6 Astra；CLI 由 GPT-5.6 Terra 实施)

- 意图：客服收到“注销一直处理中”反馈时，能查清持久任务阶段，而不触发第二次删除。
- 决策：复用现有 `careclosurejobs` 和独立 Mongo 连接，新增单任务只读入口；不加载应用启动文件、不解密归档、不启动 worker。
- 理由：时间过去不代表遗留清理操作已停止；自动释放 claim 可能造成旧清理操作与新账号资料交叉执行。
- 证据：helper 与 CLI 定向测试覆盖只读投影、状态分类、异常信息脱敏、非法 ID、独占连接和断开；精确运行记录见工作区 `outputs/cboard-private-readiness-20260913/account-boundary-review-20260917.md`。未连接实际业务库验证。
- 生效范围：本地诊断工具。不是自动修复、告警调度、服务器部署或云端资料确已删除的独立证明。

在受控运维环境中配置 `CARE_CLOSURE_MONGO_URI`（建议使用只读数据库账号），并把用户回执对应的 operationId 设置为 `CARE_CLOSURE_OPERATION_ID`。不要将 URI、密码或用户的回执 secret 粘到工单或命令日志。

```sh
node scripts/inspectCareClosureJob.js
```

该命令不需要启用 worker 开关。只查询指定任务的阶段和调度字段；不会返回账号标识、家庭、图片地址、回执凭据或原始 claim。不存在的任务报 `CLOSURE_JOB_UNAVAILABLE`，不能解释成删除完成。

| nextAction | 含义与处理 |
| --- | --- |
| `none` | 持久任务标记 complete，且未发现该元数据内的矛盾；不是额外检查了所有外部存储。 |
| `wait_for_scheduled_attempt` | 下一次尝试时间尚未到达；检查既有调度是否实际运行。本工具不创建调度。 |
| `run_existing_worker` | 已到尝试时间且未见人工核对标记；按原有受控 worker 流程处理，不再次请求账号注销。此建议不证明调度或媒体服务已就绪。 |
| `operator_review` | 阶段未知、元数据损坏、人工核对标记或遗留 claim 等；先核实原 worker/provider 操作的实际状态及持久化结果。禁止只凭超时清除 claim。 |

`evidenceScope=persisted_job_metadata` 明确限定证据范围。任何自动恢复或人工写库都不在本入口内；未知上传、旧清理 claim 的可审计恢复仍需另行实现和验证。诊断时不要公开患者内容，也不要把原始数据库行附到普通日志。
