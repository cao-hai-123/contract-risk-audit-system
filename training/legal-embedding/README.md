# 法律 Embedding 微调工程

本目录为可复现的本地训练工程，不是已经验证可上线的模型。默认运行中的检索模型仍是项目托管的 `Qwen3-Embedding-0.6B-Q8_0`，仅在 `127.0.0.1:11436` 提供向量服务。

## 数据边界

- `data/review-required-pairs.jsonl` 由脱敏受控回归集生成，所有标签均处于待法律专家复核状态。
- 不读取或导出用户上传的合同、问答正文或 DeepSeek 内容用于训练。
- CUAD 仅在建立中英商业合同条款映射后用于条款检索评测；LeCaRD 仅用于中文法律检索排序评测，不能作为合同风险真值。

## 执行顺序

1. `npm run training:embedding:prepare`
2. `npm run training:embedding:validate`
3. 法律人员复核数据，将 `reviewStatus` 改为 `approved`，并补充真实但脱敏的业务条款对。
4. 在具备 CUDA 的 Python 环境中安装 `pip install -r training/legal-embedding/requirements.txt`。
5. 使用经复核的数据执行 `python training/legal-embedding/train.py --data training/legal-embedding/data/approved-pairs.jsonl --output training/legal-embedding/output`。
6. 对受控回归集、CUAD 映射集和 LeCaRD 检索集分别评测；只有所有门槛通过，才可以人工决定是否导出 GGUF 并调整 `LOCAL_EMBEDDING_*` 环境变量。

训练或评测失败时，服务会继续使用已验证的原始 Qwen3-Embedding-0.6B 模型，不会自动切换。
