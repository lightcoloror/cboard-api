# 图语家 API 腾讯云轻量服务器部署手册

> 状态：部署资产已准备，尚未购买服务器、域名，尚未进行公网验收。

## 目标

在不绑定具体云厂商增值服务的前提下，把 CBoard API、MongoDB 和 HTTPS 入口作为一套可重复部署、可检查、可备份、可恢复的基础设施。第一版即使暂不购买短信、Azure 私有图库、AI 或方言识别，也能运行基础账号与设置同步服务。

## 变动记录

### 最小生产配置

- 意图：让尚未购买可选云服务的项目也能准备并验证生产配置。
- 决策：MongoDB、会话密钥、JWT 密钥、HTTPS 域名和限流配置为必需；Azure 私有图库与腾讯短信改为显式启用后才必需。
- 理由：可选供应商不应阻止基础 API 上线，但启用后的凭据缺失必须失败关闭。
- 证据：`npm run verify:production-deploy-template` 和生产部署配置单元测试。
- 生效范围：`deploy/.env.production.example`、生产配置检查器及 Docker Compose 环境变量。

### 一键部署与健康检查

- 意图：减少首次部署时手工输入错误。
- 决策：`deploy.sh` 必须先校验配置和 Compose，再构建启动，最后通过公网 HTTPS `/health` 验收。
- 理由：容器启动成功不等于用户手机可以访问，HTTPS 健康检查才是发布前最低证据。
- 证据：脚本静态检查与部署配置检查器；真实公网证据要等购买服务器、域名并解析后补充。
- 生效范围：腾讯云轻量应用服务器或任何支持 Docker Compose 的 Linux 主机。

### MongoDB 备份与恢复

- 意图：防止用户图板、设置和账号数据因升级或误操作丢失。
- 决策：备份默认保留 14 天并使用权限受限的压缩归档；恢复必须显式设置 `CONFIRM_RESTORE=RESTORE`，且默认使用 `--drop` 做完整恢复。
- 理由：自动备份应容易执行，破坏性的恢复必须难以误触。
- 证据：脚本会拒绝空备份、非法保留天数、空归档和未确认恢复。
- 生效范围：生产 Docker Compose 中的 MongoDB 数据。上线后仍需把备份复制到另一存储位置，避免服务器整机损坏时同时丢失原库和备份。

### 安全生成生产环境配置

- 意图：避免第一次部署时手工生成弱密钥、重复密钥，或把真实密钥输出到终端记录。
- 决策：使用 `npm run prepare:production-env -- <API 域名> <证书联系邮箱>` 从受控模板生成 `deploy/.env.production`；生成器使用独立随机密钥、拒绝覆盖已有文件，并在写入后立即执行生产配置校验。
- 理由：域名和服务器可以稍后购买，但密钥生成与配置校验流程应先固化并经过测试。
- 证据：生成器单元测试覆盖有效配置、非法域名/邮箱、弱密钥、重复密钥、npm 位置参数和拒绝覆盖；本地隔离 Mongo 演练使用生成配置通过真实容器启动。
- 生效范围：未来首次生产部署的基础 MongoDB、会话、JWT 和图符代理密钥；不生成短信、AI、OCR、Azure 或方言服务凭据。

购买域名并确定证书联系人邮箱后，在服务器仓库目录执行：

```bash
npm run prepare:production-env -- api.example.com admin@example.com
```

命令成功后只报告配置文件路径，不打印任何密钥。若文件已经存在，命令会拒绝覆盖；需要更换配置时必须先人工备份并明确处理旧文件。

## 等待购买后执行

1. 购买腾讯云轻量应用服务器，地域建议广东广州，首期建议 2 核 4 GB。
2. 购买并完成实名认证的域名，建议将 `api.<域名>` 指向服务器公网 IP。
3. 完成域名 ICP 备案和小程序备案。
4. 只开放 SSH、HTTP、HTTPS；不要向公网开放 MongoDB 的 27017 端口。
5. 在服务器安装 Docker Engine、Compose 插件、Git 和 curl。
6. 将代码检出到服务器并安装项目依赖。
7. 使用上方 `prepare:production-env` 命令生成并校验 `deploy/.env.production`，不要把真实配置提交到 Git。
8. 执行：

```bash
chmod +x deploy/scripts/*.sh
./deploy/scripts/deploy.sh
```

9. 在微信公众平台把 `https://api.<域名>` 配置为合法的 request、uploadFile 和 downloadFile 域名。
10. 将微信小程序生产环境中的 API 地址和所需功能开关改为正式值，重新构建、预览和提审。

## 日常操作

```bash
# 健康检查
./deploy/scripts/health-check.sh

# 创建本地服务器备份
./deploy/scripts/backup-mongo.sh

# 人工确认后恢复
CONFIRM_RESTORE=RESTORE ./deploy/scripts/restore-mongo.sh \
  deploy/.env.production deploy/backups/mongo-时间.archive.gz
```

## 尚未完成的真实验收

- 没有服务器和域名，因此尚未验证公网 HTTPS、证书自动续期、DNS 生效或微信真机网络请求。
- 没有异地对象存储，因此当前脚本只准备服务器本机备份；正式试用前至少要人工下载一份备份或配置另一处加密存储。
- 没有购买短信、AI、OCR、在线补图和方言识别供应商服务，因此这些能力应在微信生产构建中保持关闭。
## 本地容灾演练证据

- 时间：`2026-07-30 21:29:43`
- 执行工具 / 模型：`Codex（GPT-5）`
- 意图：在购买服务器前验证生产 MongoDB 备份与恢复所依赖的真实命令，而不只做静态脚本检查。
- 决策：使用独立 Compose 项目 `picinterpreter-drill`、独立网络和独立数据卷；只操作测试数据库 `picinterpreter-drill`，演练结束后删除容器、网络、卷和临时密钥。
- 理由：恢复命令具有破坏性，必须先在完全隔离的本地环境证明备份非空、修改后可恢复且不会接触开发库或未来生产库。
- 证据：MongoDB `7.0.37` 容器达到 `healthy`；写入值 `before-restore`；生成 `364` 字节 gzip archive；将值改为 `after-backup`；以 `mongorestore --drop` 恢复后读回 `{"_id":"backup-proof","value":"before-restore"}`；隔离容器和卷随后成功删除。
- 生效范围：证明 Docker Mongo 的 `mongodump` / `mongorestore` 核心路径在当前电脑可用；不等于部署脚本已在真实 Linux 服务器、定时任务或异地存储上验收。
