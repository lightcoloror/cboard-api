#!/usr/bin/env python3
"""Persistent offline CPU JSONL embedding worker for Mulberry BGE-small-zh-v1.5 queries."""

import sys

sys.dont_write_bytecode = True

import argparse
import contextlib
import json
import os
from pathlib import Path

OFFLINE_ENV = {
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "CUDA_VISIBLE_DEVICES": "",
    "OMP_NUM_THREADS": "1",
    "MKL_NUM_THREADS": "1",
    "TOKENIZERS_PARALLELISM": "false",
    "PYTHONDONTWRITEBYTECODE": "1",
}
for _k, _v in OFFLINE_ENV.items():
    os.environ[_k] = _v


def _audit_no_network(event, args):
    if event in ("socket.connect", "socket.getaddrinfo"):
        raise RuntimeError(f"Network disabled for offline Mulberry BGE worker: {event}")


sys.addaudithook(_audit_no_network)


def main():
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="Offline CPU BGE query embedder JSONL worker")
    parser.add_argument("--model", required=True)
    parser.add_argument("--deps", default="")
    args = parser.parse_args()

    model_path = Path(args.model).resolve()
    if not (model_path / "model.safetensors").is_file():
        raise FileNotFoundError(f"Missing model.safetensors in {model_path}")

    if args.deps:
        deps_path = Path(args.deps).resolve()
        if str(deps_path) not in sys.path:
            sys.path.insert(0, str(deps_path))

    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from sentence_transformers import SentenceTransformer

        torch.set_num_threads(1)
        try:
            torch.set_num_interop_threads(1)
        except (AttributeError, RuntimeError):
            pass

        model = SentenceTransformer(str(model_path), device="cpu", local_files_only=True)

    print(json.dumps({"ready": True, "dim": 512}, ensure_ascii=False), flush=True)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        req_id = None
        try:
            payload = json.loads(line)
            if isinstance(payload, dict) and payload.get("cmd") == "quit":
                break
            req_id = payload.get("id")
            text = str(payload.get("text") or "").strip()[:120]
            if not text:
                print(json.dumps({"id": req_id, "error": "empty_text"}), flush=True)
                continue
            with contextlib.redirect_stdout(sys.stderr):
                vec = model.encode(
                    [text],
                    batch_size=1,
                    show_progress_bar=False,
                    normalize_embeddings=True,
                    convert_to_numpy=True,
                )[0]
            out_vec = [round(float(x), 6) for x in vec.tolist()]
            print(json.dumps({"id": req_id, "vector": out_vec}, ensure_ascii=False), flush=True)
        except Exception as exc:
            print(json.dumps({"id": req_id, "error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()
