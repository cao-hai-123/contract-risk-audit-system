# 源码上传验收记录

2026-10-09：从现有工作区以白名单建立独立源码副本。原工作区和数据库未迁移、未删除。

## 排除项目

真实合同、OCR 语料、数据库内容与备份、本机密钥、模型权重、运行环境、视频、历史工作日志、真实合同测试附件，以及包含本机演示输入路径的视频脚本。

## 已执行

- 副本生成前，对选中文件匹配本机密钥和密码（只输出匹配文件路径，不输出凭据），结果为零匹配。
- 常见 API/GitHub 密钥格式与私钥标记检查，结果为零匹配。
- 保留 FAMIE 上游许可证和运行所需源码。

## 构建与测试结果

- `npm ci --no-audit --no-fund`：成功，安装 206 个依赖包。
- `npm run build`：成功，Vite 转换 1577 个模块。
- `node --test --test-isolation=none tests/priority-repairs.test.js tests/local-inference.test.js tests/backup-retrieval.test.js tests/startup-recovery.test.js tests/dev-orchestration.test.js tests/model-upgrade.test.js`：57 项全部通过，失败 0，跳过 0。
- 覆盖上传状态、过期请求、模型证据约束、降级状态、代理异常恢复、OCR、报告版本、全文检索、备份校验及启动错误分类。

这是不携带生产数据库和真实合同的代码回归，不代表新的部署环境、真实 Qwen/DeepSeek 调用或完整语料库集成均已验证。

安装时提示 Multer 1.x 与 lucide-vue-next 弃用信息；本次保持现有锁文件，没有顺带升级业务依赖。测试进程出现 Vue 生命周期和 Node localStorage 警告，57 项断言仍通过；API 启动兼容参数专项测试通过。

远端仓库创建、提交推送和提交一致性由本次交付结果另行说明。
