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

## 等待购买后执行

1. 购买腾讯云轻量应用服务器，地域建议广东广州，首期建议 2 核 4 GB。
2. 购买并完成实名认证的域名，建议将 `api.<域名>` 指向服务器公网 IP。
3. 完成域名 ICP 备案和小程序备案。
4. 只开放 SSH、HTTP、HTTPS；不要向公网开放 MongoDB 的 27017 端口。
5. 在服务器安装 Docker Engine、Compose 插件、Git 和 curl。
6. 将代码检出到服务器，复制 `deploy/.env.production.example` 为 `deploy/.env.production`。
7. 生成至少 32 字符且彼此不同的 MongoDB、会话和 JWT 密钥，不要把真实密钥提交到 Git。
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
