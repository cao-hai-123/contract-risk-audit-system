# 企业合同智能审核与风险预警系统

基于 Vue 3、Node.js、MySQL 和本地 Qwen 的合同处理原型。支持合同解析、OCR 预览、风险审核、标准条款比对、问答、审核报告、历史记录与独立印章分析。输出用于辅助人工复核，不构成法律意见；印章视觉匹配不能证明印章或合同真实性。

## 架构

| 目录 | 职责 |
| --- | --- |
| `src/` | Vue 3 + Vite 页面、模块组件及请求状态管理 |
| `backend/server.js` | Express API、上传及业务接口 |
| `backend/services/` | 解析、OCR、模型调用、风险和条款库、混合检索、报告、备份和删除策略 |
| `backend/db.js`、`backend/schema.sql` | MySQL 建表与启动时结构维护；实际结构升级以 db.js 为准 |
| `backend/seal/` | 独立印章图像处理 Python 组件 |
| `shared/` | 前后端共享合同内容逻辑 |
| `scripts/`、`tests/` | 初始化、模型部署、维护及自动测试 |
| `third_party/famie/` | 可选 FAMIE 独立服务，保留上游 GPL-3.0 许可 |
| `training/legal-embedding/` | 嵌入训练准备代码；不包含合同训练数据 |

MySQL 存储解析、操作记录、风险规则、标准条款来源、向量索引、合同版本、报告快照和人工复核状态。业务数据不随仓库分发；历史 JSON 仅作迁移输入。

## 主要能力与边界

- 解析 PDF、DOCX、DOC、图片；扫描文件需要 OCR，保留段落并抽取合同类型和要素。
- 风险审核与条款比对先执行确定性规则，再按可用性调用本地模型；云端复核须由本次请求显式开启。
- 合同问答以检索证据生成本地草稿，再调用配置好的 DeepSeek；可能向云端发送检索到的合同片段，使用前应确认有权处理相关数据。
- 检索结合关键词与本地嵌入；嵌入失败时显示关键词降级结果。
- 报告包含快照、合同版本与人工确认状态，支持 Word/PDF/HTML 导出。
- 历史记录支持服务端分页、归档及范围预览后确认删除。
- 印章模块独立运行，提供图像分析和相似性证据，不输出无依据的真实性保证。
- FAMIE 通过手动导入脱敏样本进行标注；登记检查点不代表已通过推理评测。

## 本地启动

准备 Node.js 22 或更新的兼容版本、npm 和 MySQL 8。Windows 本地模型部署还需要 PowerShell；印章模块需安装 Python 依赖。

```powershell
npm ci
Copy-Item .env.example .env
# 编辑 .env 中的 DB_HOST、DB_PORT、DB_USER、DB_PASSWORD 和 DB_NAME
# 数据库账号须有项目库建表权限；首次自动建库需要 CREATE DATABASE 权限
npm run dev
```

默认前端 `http://127.0.0.1:5173`，API `http://127.0.0.1:3001`。不要提交 `.env`。启用 DeepSeek 时仅在本机配置 `DEEPSEEK_API_KEY`，或创建被忽略的 `deepseek-api-key.txt`；未配置云端凭据时以实际降级提示为准。

```powershell
npm run local-model:setup
npm run embedding-model:setup
npm run seal:setup
```

生成模型为 Qwen3-8B Q4_K_M（端口 11435），检索模型为 Qwen3-Embedding-0.6B Q8_0（端口 11436，1024 维），均仅监听本机。模型需单独下载；CPU 线程数、上下文和内存应按目标电脑调整。OCR 语言资源也需下载或预置；首次使用需要网络。旧 DOC 转换可能需要 LibreOffice。

## Docker

保留 `Dockerfile` 和 `docker-compose.yml`。示例 Compose 中的密码仅为占位值，部署前应替换为自己的凭据并限制 MySQL 端口访问。DeepSeek 的密钥文件挂载要求本机预先创建文件；无云端需求时可创建空文件。Docker 配置不自动包含 Windows 本地模型，Linux 模型运行时须单独配置。

```powershell
docker compose up -d --build
# 应用默认 http://127.0.0.1:8080
npm run famie:start
```

FAMIE 是可选 profile，首次构建和模型初始化需要网络；其依赖与许可证独立维护。

## 上传范围与恢复数据

仓库仅含源码、配置模板、数据库结构和不含真实合同的测试。以下资源有意排除：实际合同及标准模板、OCR 语料与索引、数据库备份和运行记录、密钥、模型权重、下载的运行时、历史验收日志、视频及本机专用文档。

因此克隆后不会自动拥有原电脑的已构建语料库、报告、印章参考库或操作记录。可在有授权的前提下自行准备 `match/` 和 `matchreal/`，按照构建脚本建立本机库；不得把私人合同提交到 Git。公共数据集及官方合同评测附件也需按来源说明独立获取，并遵守上游许可。

## 验证

```powershell
npm run build
npm run test:priority
npm run test:qwen
npm run test:backup-retrieval
```

带 MySQL、真实模型、外部合同、下载资源或云端调用的集成测试需要额外环境。`npm run check` 是原完整工作区检查，要求未分发的数据集归档等外部资源，干净克隆中不能视为全部通过。测试结果与本次发布范围见 `docs/UPLOAD-VALIDATION.md`。

## 第三方许可

FAMIE 源码保留在独立目录，许可证为 `third_party/famie/source/famie-main/LICENSE`；其他依赖按各自许可使用。本次未替项目自有代码指定开源许可证，私有仓库上传不等于授予公众再分发权限。
