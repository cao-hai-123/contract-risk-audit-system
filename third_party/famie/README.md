# FAMIE Integration Source

This directory contains the user-supplied FAMIE source under `source/famie-main/`, with project deployment patches listed below.

- Upstream: https://github.com/nlp-uoregon/famie
- Version: 0.3.0
- License: GPL-3.0-only. The upstream `LICENSE` file is retained in the source directory.
- Role in this project: an optional local annotation and active-learning service for contract key-element extraction. It is not part of the contract parsing runtime and is not automatically sent uploaded contract text.

Start the optional service after Docker Desktop is available:

```powershell
npm run famie:start
```

Then open `http://127.0.0.1:9000`. Export a desensitized training set and the entity-type file from the application's `反馈标注优化` page, upload them into FAMIE, complete human review, and export the trained checkpoint. A registered checkpoint remains unvalidated until a separate inference adapter and contract-specific evaluation are completed.

Deployment patches: persistent `FAMIE_WORKING_DIR=/home/famie/.famie`, matching argument-file location, CPU-aware Trankit initialization, and an identity-bearing `/api/health` endpoint registered after configuration and controllers load. The Docker recipe constrains the legacy Python 3.8 dependencies and installs CPU PyTorch; it limits the container to 4 CPUs and 6 GB. These changes do not turn FAMIE into active parsing inference or automatically upload contracts.

2026-09-17 verified status: Docker Linux engine and FAMIE are healthy. Docker Hub access works through the user's existing system HTTP proxy on port 7897. The image uses Trankit-compatible torch 1.7.1+cpu with passing `pip check` and UID 10001 storage. Source-checked patches migrate retired model URLs and handle relative Hub redirects; tokenizer initialization now prefers local cache. Five offline dependency-patch regressions, full network-disabled initialization and four live acceptance groups passed, including real Edge rendering and a restart that returned ready in 21.832 seconds. This does not validate annotation training or checkpoints. See [network repair steps](../../docs/famie-docker-network-repair-2026-09-16.md) for instructions and evidence. No automatic Windows restart or contract upload was performed.
