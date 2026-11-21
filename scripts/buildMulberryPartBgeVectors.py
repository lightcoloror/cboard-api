#!/usr/bin/env python3
"""Offline CPU BGE-small-zh-v1.5 vectorizer & per-row int8 quantizer for Mulberry 3,436 parts."""

import sys

sys.dont_write_bytecode = True

import argparse
import hashlib
import json
import os
import time
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
for k, v in OFFLINE_ENV.items():
    os.environ[k] = v

NETWORK_ATTEMPTS = []


def _audit_no_network(event, args):
    if event in ("socket.connect", "socket.getaddrinfo"):
        NETWORK_ATTEMPTS.append({"event": event, "args": repr(args[:2]) if args else ""})
        raise RuntimeError(f"Network disabled for offline Mulberry BGE build: {event}")


sys.addaudithook(_audit_no_network)

PROBE_WORDS = [
    "助听器电池",
    "轮椅坐垫",
    "眼镜盒",
    "充电宝",
    "折叠拐杖",
    "打伞",
    "血糖试纸",
    "降噪耳塞",
    "盒子",
    "拳击",
    "拼图",
    "芹菜",
    "花瓶",
    "杯子",
    "橱柜",
    "火车",
    "火星",
    "拐杖",
    "奶油",
    "香肠",
]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def build_doc_text(part: dict) -> str:
    zh = str(part.get("zh") or "").strip()
    syns = [str(s).strip() for s in (part.get("synonymsZh") or []) if str(s).strip()][:5]
    if zh and syns:
        return f"{zh}；{'、'.join(syns)}"
    if zh:
        return zh
    return str(part.get("en") or part.get("partId") or "").strip()


def inspect_param_devices(model) -> list:
    devs = set()
    for p in model.parameters():
        devs.add(str(p.device.type))
    return sorted(devs)


def main():
    parser = argparse.ArgumentParser(description="Build offline int8 BGE vectors for Mulberry parts")
    parser.add_argument("--index", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--deps", required=True)
    parser.add_argument("--out-bin", required=True)
    parser.add_argument("--out-meta", required=True)
    parser.add_argument("--out-audit-dir", required=True)
    args = parser.parse_args()

    index_path = Path(args.index).resolve()
    model_path = Path(args.model).resolve()
    deps_path = Path(args.deps).resolve()
    out_bin = Path(args.out_bin).resolve()
    out_meta = Path(args.out_meta).resolve()
    audit_dir = Path(args.out_audit_dir).resolve()
    audit_dir.mkdir(parents=True, exist_ok=True)

    weights_path = model_path / "model.safetensors"
    if not weights_path.is_file():
        raise FileNotFoundError(f"Missing weights: {weights_path}")
    weights_sha256 = sha256_file(weights_path)

    sys.path.insert(0, str(deps_path))
    import numpy as np
    import torch
    from sentence_transformers import SentenceTransformer

    torch.set_num_threads(1)
    try:
        torch.set_num_interop_threads(1)
    except (AttributeError, RuntimeError):
        pass

    index_doc = json.loads(index_path.read_text(encoding="utf-8"))
    parts = index_doc.get("parts") or []
    if len(parts) != 3436:
        raise RuntimeError(f"Expected 3436 parts, found {len(parts)}")

    part_ids = [p["partId"] for p in parts]
    docs = [build_doc_text(p) for p in parts]

    t0 = time.perf_counter()
    model = SentenceTransformer(str(model_path), device="cpu", local_files_only=True)
    devs = inspect_param_devices(model)
    if devs != ["cpu"]:
        raise RuntimeError(f"Expected CPU-only model parameters, got {devs}")
    load_s = time.perf_counter() - t0

    t1 = time.perf_counter()
    vecs = model.encode(
        docs,
        batch_size=32,
        show_progress_bar=False,
        normalize_embeddings=True,
        convert_to_numpy=True,
    )
    vecs = np.asarray(vecs, dtype=np.float32)
    if vecs.shape != (3436, 512):
        raise RuntimeError(f"Unexpected embedding matrix shape: {vecs.shape}")
    encode_s = time.perf_counter() - t1

    # Per-row symmetric int8 quantization
    max_abs = np.max(np.abs(vecs), axis=1)
    scales = np.maximum(max_abs / 127.0, 1e-8).astype(np.float32)
    q = np.clip(np.round(vecs / scales[:, None]), -127, 127).astype(np.int8)

    out_bin.parent.mkdir(parents=True, exist_ok=True)
    out_bin.write_bytes(q.tobytes())

    meta_doc = {
        "schemaVersion": "1.0.0",
        "modelName": "BAAI/bge-small-zh-v1.5",
        "modelSafetensorsSha256": weights_sha256,
        "count": int(q.shape[0]),
        "dim": int(q.shape[1]),
        "quantization": "per_row_int8",
        "partIds": part_ids,
        "scales": [round(float(x), 8) for x in scales.tolist()],
    }
    out_meta.write_text(json.dumps(meta_doc, ensure_ascii=False) + "\n", encoding="utf-8")

    npz_path = audit_dir / "mulberry_bge_vectors.npz"
    with open(npz_path, "wb") as f:
        np.savez(
            f,
            part_ids=np.asarray(part_ids, dtype=str),
            docs=np.asarray(docs, dtype=str),
            vectors=vecs,
        )

    # Probe validation: float32 vs dequantized int8 cosine agreement
    t2 = time.perf_counter()
    probe_vecs = np.asarray(
        model.encode(
            PROBE_WORDS,
            batch_size=20,
            show_progress_bar=False,
            normalize_embeddings=True,
            convert_to_numpy=True,
        ),
        dtype=np.float32,
    )
    probe_s = time.perf_counter() - t2

    deq_vecs = q.astype(np.float32) * scales[:, None]
    allow_mask = np.asarray([bool(p.get("autoComposeAllowed", True)) for p in parts], dtype=bool)

    max_cosine_err = 0.0
    top3_exact_matches = 0
    probe_reports = []

    for idx_q, word in enumerate(PROBE_WORDS):
        qv = probe_vecs[idx_q]
        sim_f32 = vecs @ qv
        sim_i8 = deq_vecs @ qv
        err = float(np.max(np.abs(sim_f32 - sim_i8)))
        if err > max_cosine_err:
            max_cosine_err = err

        # Rank Top-3 on autoComposeAllowed subset
        f32_masked = np.where(allow_mask, sim_f32, -1e9)
        i8_masked = np.where(allow_mask, sim_i8, -1e9)
        top3_f32 = [int(i) for i in np.argsort(-f32_masked, kind="stable")[:3]]
        top3_i8 = [int(i) for i in np.argsort(-i8_masked, kind="stable")[:3]]
        exact_top3 = top3_f32 == top3_i8
        if exact_top3:
            top3_exact_matches += 1

        probe_reports.append(
            {
                "query": word,
                "maxCosineErr": round(err, 6),
                "top3ExactMatch": exact_top3,
                "top3Int8": [
                    {
                        "partId": parts[i]["partId"],
                        "file": parts[i]["file"],
                        "zh": parts[i]["zh"],
                        "score": round(float(sim_i8[i]), 4),
                    }
                    for i in top3_i8
                ],
            }
        )

    top3_agreement = top3_exact_matches / len(PROBE_WORDS)
    receipt = {
        "status": "offline_cpu_int8_complete",
        "modelName": "BAAI/bge-small-zh-v1.5",
        "modelSafetensorsSha256": weights_sha256,
        "parameterDevices": devs,
        "network_attempts": NETWORK_ATTEMPTS,
        "counts": {"parts": len(parts), "dim": int(vecs.shape[1]), "probes": len(PROBE_WORDS)},
        "bytes": {"int8Bin": out_bin.stat().st_size, "metaJson": out_meta.stat().st_size},
        "seconds": {"load": round(load_s, 3), "encode3436": round(encode_s, 3), "encode20Probes": round(probe_s, 3)},
        "quantizationValidation": {
            "maxCosineError": round(max_cosine_err, 6),
            "top3ExactAgreementCount": top3_exact_matches,
            "top3ExactAgreementRatio": round(top3_agreement, 4),
        },
        "probes": probe_reports,
    }
    (audit_dir / "bge_build_receipt.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    # Save normalized float32 probe vectors to audit dir for optional cross-check
    (audit_dir / "probe_queries_vectors.json").write_text(
        json.dumps(
            {word: [round(float(x), 6) for x in probe_vecs[i].tolist()] for i, word in enumerate(PROBE_WORDS)},
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    assert max_cosine_err < 0.01, f"Max cosine quantization error too large: {max_cosine_err}"
    assert top3_agreement >= 0.95, f"Top-3 int8 vs f32 agreement below 95%: {top3_agreement}"
    assert len(NETWORK_ATTEMPTS) == 0, f"Unexpected network attempts: {NETWORK_ATTEMPTS}"

    print(
        "BUILD_BGE_STEP1_DONE:",
        json.dumps(
            {
                "parts": len(parts),
                "binBytes": out_bin.stat().st_size,
                "metaBytes": out_meta.stat().st_size,
                "encodeSec": round(encode_s, 2),
                "maxCosineErr": round(max_cosine_err, 6),
                "top3Agreement": f"{top3_exact_matches}/{len(PROBE_WORDS)}",
                "networkAttempts": len(NETWORK_ATTEMPTS),
            },
            ensure_ascii=False,
        ),
    )


if __name__ == "__main__":
    main()
