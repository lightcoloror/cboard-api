# cboard-api 跨平台测试启动器决策

## 变动 1：标准控制器测试入口兼容 Windows

- **意图：** 让作为图语家全平台技术底座的 `cboard-api` 在 Windows、macOS 和 Linux 上使用同一条标准测试命令，避免 Windows 把 POSIX 风格的 `NODE_ENV=test` 当成不可执行命令。
- **决策：** `npm test` 改由无新增依赖的 `scripts/runControllerTests.js` 启动；启动器在子进程环境中设置 `NODE_ENV=test`，再用当前 Node 进程调用仓库已安装的 Mocha。新增 `npm run test:unit`，只执行 `test/controllers/**/*.unit.js`；完整 `npm test` 仍保留全部控制器和集成测试语义。
- **理由：** 引入 `cross-env` 会产生额外依赖和 lockfile 噪音，直接按操作系统拼 shell 命令又会复制平台分支。Node `spawnSync` 是现有运行时能力，可保持 Mocha 参数、退出码和标准输出，同时把不依赖数据库的快速门与需要 Mongo、邮件和第三方配置的完整门明确分开。
- **证据：** Windows 上 `node scripts/runControllerTests.js --help` 成功进入仓库现有 Mocha；`npm run test:unit` 完成 `374 passing`；`node --check scripts/runControllerTests.js`、Prettier 检查和 `git diff --check` 均通过。完整套件此前已进入 Mocha 并因本机缺少 Mongo、邮件和 IPInfo 配置失败，证明原 Windows 环境变量语法阻断已消除，但外部集成环境仍需单独提供。
- **生效范围：** 仅影响 `cboard-api` 的本地和 CI 测试启动方式，不改变 API 路由、数据库模型、图语家业务逻辑、依赖版本或 lockfile；不把纯单元测试结果写成 Mongo/邮件/第三方服务联调通过。
- **记录：** Codex（GPT-5.6），2026-07-28 20:04:08。
