"""Local LoRA fine-tuning entry point. It refuses unreviewed labels by design."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--base-model', default='Qwen/Qwen3-Embedding-0.6B')
    args = parser.parse_args()

    rows = [json.loads(line) for line in Path(args.data).read_text(encoding='utf-8').splitlines() if line.strip()]
    if not rows or any(row.get('reviewStatus') != 'approved' for row in rows):
        raise SystemExit('Only legally reviewed, explicitly approved training pairs may be used for fine-tuning.')
    if not any(row.get('label') == 1 for row in rows) or not any(row.get('label') == 0 for row in rows):
        raise SystemExit('The approved dataset must contain both positive and negative retrieval labels.')

    # The deliberately explicit dependency check prevents a partial or CPU-only run from being mistaken for training.
    import torch
    from transformers import AutoModel, AutoTokenizer
    from peft import LoraConfig, TaskType, get_peft_model

    if not torch.cuda.is_available():
        raise SystemExit('CUDA is required for the supported local LoRA training path.')

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)
    model = AutoModel.from_pretrained(args.base_model, trust_remote_code=True, torch_dtype=torch.float16).cuda()
    lora = LoraConfig(task_type=TaskType.FEATURE_EXTRACTION, r=16, lora_alpha=32, lora_dropout=0.05, target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj'])
    model = get_peft_model(model, lora)
    model.train()

    positives = [row for row in rows if row['label'] == 1]
    negatives = [row for row in rows if row['label'] == 0]
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-5)
    for index, row in enumerate(positives):
        negative = negatives[index % len(negatives)]
        tokens = tokenizer([row['query'], row['passage'], negative['passage']], return_tensors='pt', padding=True, truncation=True, max_length=512).to('cuda')
        vectors = model(**tokens).last_hidden_state[:, -1, :]
        vectors = torch.nn.functional.normalize(vectors, dim=-1)
        positive_similarity = (vectors[0] * vectors[1]).sum()
        negative_similarity = (vectors[0] * vectors[2]).sum()
        loss = torch.relu(0.2 - positive_similarity + negative_similarity)
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(output)
    tokenizer.save_pretrained(output)
    (output / 'training-metadata.json').write_text(json.dumps({'baseModel': args.base_model, 'rows': len(rows), 'status': 'requires_independent_evaluation'}, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
