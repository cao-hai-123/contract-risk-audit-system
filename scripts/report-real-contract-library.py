"""Truthful snapshot report from persisted receipts; no inferred accuracy claims."""
import json,time,collections
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'data/real-contract-corpus'
def read(name):
    p=OUT/name
    return json.loads(p.read_text('utf8')) if p.exists() else {}
documents=[json.loads(p.read_text('utf8')) for p in (OUT/'documents').glob('*.json')]
dc=collections.Counter(d['status'] for d in documents);pc=collections.Counter(p['status'] for d in documents for p in d['pages'])
build=read('build-result.json');integrity=read('evaluation/integrity-mysql.json');before=read('evaluation/before.json');after=read('evaluation/after.json');holdout=read('evaluation/holdout-consistency.json');model=read('model-summary.json');pipeline=read('pipeline-status.json')
inventory=read('manifest.json');counts=collections.Counter(f['status'] for f in inventory.get('files',[]))
text=f'''# 真实合同证据库构建与比对效果核验报告

更新时间：{time.strftime('%Y-%m-%d %H:%M:%S %z')}。本文件为生成时快照；实时批处理进度见 `data/real-contract-corpus/pipeline-status.json`。

## 一、结论及完成边界

已构建本地文字提取、来源追踪、候选条款证据、MySQL 发布与回读验证流程，并修复比对器在要素缺失时仍判为“完整”的问题。**尚不能宣称已经建立法律有效、全面完备的标准合同库，也未测得真实业务准确率提升百分比。**

已有标准库的 40 个审阅主题继续保留；真实合同用于补充可追溯的候选证据。真实合同中的约定并不天然合法、公平、完整或适用于其他交易，因此候选库不会自动覆盖标准定义或提高某份待审合同的完整性评分。

## 二、数据范围和处理状态

- `matchreal` 清点 {len(inventory.get('files',[]))} 个 PDF 路径；{counts.get('duplicate',0)} 份二进制重复副本、{counts.get('excluded_by_prior_review',0)} 份此前排除文件不重复纳入。
- 保留 {len(documents)} 份唯一文件，{sum(pc.values())} 页。用户“杂项”文件保留“用户提供、原始网页出处未核实”标记，不冒充官方已核实来源。
- 当前文件状态：{dict(dc)}。`extracted` 仅表示提取流程完成，不是完整合同认证，也不是 OCR 无误保证。
- 当前页状态：{dict(pc)}。待识别、失败或需要人工复核的页面不会作为已完成页用于证据库。
- 网上来源使用已下载的 [CUAD 官方 GitHub 分发档案](https://github.com/The-Atticus-Project/cuad)，提取 510 份英文商业合同上下文及标签，保存原始档案 SHA-256；不是本轮新下载 510 个 PDF。
- CUAD 保留在 `datasets/archive/cuad-extracted`，仅用于英文提取评测准备，未混入中文标准库、未直接作为中国合同法律风险真值；其 [CC BY 4.0 授权说明](https://www.atticusprojectai.org/legal/)保留为来源依据。

## 三、库结构与实际入库

最近构建时间：{build.get('builtAt','未记录')}；构建版本：`{build.get('buildId','未生成')}`。

|项目|最近构建快照|
|---|---:|
|登记唯一文件|{build.get('sources',0)}|
|候选证据片段|{build.get('evidence',0)}|
|审阅主题|{build.get('topics',0)}|
|发现候选证据的主题|{build.get('topicsWithEvidence',0)}|
|识别为公示摘要的文件|{build.get('noticeSummaries',0)}|

发布状态：`{build.get('publication',{}).get('status','未发布')}`。登记文件数包含待提取或待复核文件，不等于有效标准来源数。实际用于运行时支持的来源数由已入库证据独立统计。

新增三张 MySQL 表：`real_contract_corpus_builds` 记录版本与状态；`real_contract_corpus_sources` 记录文件哈希、出处、分组与解析状态；`real_contract_clause_evidence` 记录主题、页码、文本偏移、引文哈希及候选审阅状态。事务提交后才发布版本；重复构建幂等；失败事务回滚。原 `standard_clause_library` 未被未审阅合同覆盖。

证据引用校验针对实际识别文本：能够复核出处和字符位置，但不等于已人工逐字核准扫描图像。OCR 平均置信度门槛也不构成法律有效性认证。基本号码、手机及邮箱遮盖不是完整脱敏，不能据此直接开始模型训练。

## 四、模型及处理方式

1. PDFium 逐页提取文字和页码，图像页交给本地 [RapidOCR](https://github.com/RapidAI/RapidOCR) 的 PP-OCRv4 模型识别，保存原生文字、OCR 文字、文本框和置信度。源 PDF 字节保持不变。
2. CPU OCR 默认两个工作进程，逐页检查点，支持失败页重试；与 Qwen 串行运行。并行内存压力曾导致 ONNX 分配失败，相关失败没有标为成功。
3. 继续使用已有 Qwen3-8B Q4_K_M 在本机整理要点；只接收给定证据的逐字引文，模型摘要仍待语义及适用性审阅。未另外下载法律生成模型，未训练或替换现有权重。
4. 模型摘要快照状态：`{model.get('status','未运行')}`，通过引用校验的候选数 {len(model.get('accepted',[]))}；摘要是否对应当前构建版本：{'是' if model.get('buildId')==build.get('buildId') else '否（旧版试运行，不能当作当前全库已完成）'}。原始状态 ready 表示模型服务就绪，不代表全批摘要完成；只有 completed_candidates_only 才表示该批请求走完。
5. 未发送真实合同到 DeepSeek 或其他云端模型；未用未经人工审阅的真实文本训练模型。

## 五、准确率提升：能证明什么

|测试|改动前|改动后|解释|
|---|---:|---:|---|
|14 个模拟缺项/完整对照测试|{sum(r.get('passed',False) for r in before.get('controls',[]))}/14|{sum(r.get('passed',False) for r in after.get('controls',[]))}/14|针对已发现缺陷的诊断测试，不代表业务准确率|
|留出合同中“完整但仍有缺项”的矛盾判定|{holdout.get('before','未测')}|{holdout.get('after','未测')}|{holdout.get('documents',0)} 份提取完毕合同、{holdout.get('checks',0)} 个主题探针，仅测内部一致性|

模拟测试通过率从 57.14% 提高到 100%，提升 42.86 个百分点；**不能表述为真实合同比对准确率提高 42.86 个百分点**。三个独立官方模板回归分数保持 92、88、69，均无新增缺失主题。新证据库暂不自动影响标准判定，所以无法把上述修复收益归因于新增合同数量。

留出组按识别文本哈希划分，精确重复文本不会进入两组；近似模板家族独立性尚未认证。全部主题只作为探针运行，不把不适用主题当成合同缺陷。没有律师/业务专家独立标注的真实测试集，尚无法可靠报告真实 precision、recall、F1、误报率或统计显著提升。

## 六、自检证据

- 46 项单元与回归测试已通过；包含原优先缺陷测试、行业规则测试和新增语料证据测试。Vite 构建与项目要求检查已通过。
- 独立 MySQL 9.4 模拟数据测试：事务发布、重复发布幂等、UTF-8/引号参数化、失败回滚通过，未改动业务服务配置。
- 当前业务库完整性回执：`{integrity.get('passed','未执行')}`，版本是否与当前构建一致：`{integrity.get('buildId')==build.get('buildId')}`。具体源文件和引文校验条数见回执，不把旧回执当新构建的验证。
- 4 页模拟中文 OCR 测试通过，字符错误率分别为 0%、0%、2.94%、3.33%，测试数字均保留；真实扫描件的字符错误率尚无人工真值测量。
- 回执目录：`data/real-contract-corpus/evaluation/`，包含 before/after、holdout-consistency、integrity-mysql、mysql-isolated、ocr-smoke。

## 七、完全处理、部分处理、未处理

**已完全处理（代码及已执行范围）**：文件清点与去重；可追溯文字/证据格式；MySQL 独立候选库及回读；前端真实状态提示；缺项仍判“完整”的阈值漏洞修复；上述已通过的测试。

**部分处理**：全量 OCR、全部主题 Qwen 整理、源页面出处复核、语料内容完整性复核。批处理状态：`{pipeline.get('status','未记录')}`。当前阶段：`{pipeline.get('stages',[{}])[-1].get('name','未记录')}`。不要把后台开始运行等同完成。

**未处理完成**：专家审定的全面标准库；合法性、适用行业和有效版本的逐项审查；人工标注的独立真实准确率评测；法律模型微调及受控晋升。仅凭未经审阅的真实合同或模型总结不能可靠完成这些验收。

## 八、续跑和查看进度

批处理程序：`scripts/run-real-contract-pipeline.py`。按 OCR→清单刷新→候选库入库→本地 Qwen 摘要→诊断/留出/文件/数据库/回归测试串行执行。每阶段日志位于 `data/real-contract-corpus/*-pipeline.log`，实时状态每约 15 秒写入 pipeline-status.json。

不要在现有批处理仍运行时重复启动。异常中断后先检查 pipeline.lock 中 PID 对应进程是否已退出，再移除该单个过期锁并续跑；所有原合同及逐页检查点保留。业务 MySQL 必须保持运行。电脑关闭或进程被终止后任务不会自行恢复。
'''
dest=ROOT/'docs/真实合同条款库构建与效果报告.md';dest.write_text(text,'utf8');print(str(dest))
