# Public Dataset Workspace

This folder keeps public legal NLP data separate from uploaded contracts and runtime records.

- `archive/cuad-main.zip`: CUAD source archive. CUAD is an English commercial-contract clause dataset and is suitable for clause extraction or retrieval benchmark design after a documented label mapping.
- `archive/LeCaRD-main.zip`: LeCaRD source archive. LeCaRD is a Chinese legal case-retrieval dataset; use it to evaluate Chinese legal semantic retrieval, not as direct ground truth for commercial-contract risk labels.

Do not copy dataset samples into `data/`, MySQL operation records, browser demos, or logs. Preserve each upstream license and cite the source in evaluation reports.

The initial project evaluation target is offline rule matching: precision, recall, macro F1, false-positive rate, and latency against an explicitly documented mapping and a desensitized validation split. No public dataset is treated as legal advice or as a direct substitute for Chinese commercial-contract expert labels.
