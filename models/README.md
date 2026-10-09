# Project-managed local model

The runtime uses the official `Qwen/Qwen3-8B-GGUF` `Q4_K_M` file with the CPU backend of the official Windows `llama.cpp` runtime.

- Verified machine: i7-14700, 32 GB RAM, Intel UHD 770; CPU inference, no CUDA offload.
- Runtime: `runtime/llama.cpp/llama-server.exe`.
- Model path: `models/Qwen3-8B-Q4_K_M.gguf` (5,027,783,488 bytes).
- SHA-256: `d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785`.
- CPU: 16 generation threads, 28 batch threads; context 8192, one slot, reasoning disabled for bounded structured tasks. Selected by the 2026-09-16 same-build CPU/Vulkan benchmark; UHD 770 GPU generation was slower. See `docs/performance-library-famie-2026-09-16.md` for measured scope and limitations.
- Dedicated retrieval embeddings remain Qwen3-Embedding-0.6B Q8_0 on port 11436, 1024 dimensions. This model performs a different task and is not replaced by the generation model.
- Bind address: `127.0.0.1:11435` only.
- Scope: risk-finding review and cautious structured contract-text organization; the local rule library remains the deterministic fallback.

Run `npm run local-model:setup` once to download the runtime and model, then start the project normally with `npm run dev`. The model and downloaded binaries are intentionally excluded from source control.
