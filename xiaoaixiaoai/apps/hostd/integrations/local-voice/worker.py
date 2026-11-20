#!/usr/bin/env python3
"""NDJSON stdio worker for local FunASR + GPT-SoVITS v2ProPlus voice (single-threaded for Windows C-extension stability)."""
from __future__ import annotations

import base64
import json
import math
import os
import re
import sys

# Redirect library prints/warnings from Python stdout to stderr while keeping protocol stdout isolated.
_proto_out = sys.stdout
sys.stdout = sys.stderr


def emit(payload: dict) -> None:
    _proto_out.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _proto_out.flush()


CONFIG = json.loads(os.environ.get("LOCAL_VOICE_CONFIG_JSON", "{}") or "{}")
CHUNK_BYTES = 15360
TARGET_OUT_RATE = 48000
TARGET_ASR_RATE = 16000

_cancelled_ids: set[str] = set()
_asr_model = None
_tts_engine = None
_resample_poly = None
_np = None


def _ensure_models() -> None:
    global _asr_model, _tts_engine, _resample_poly, _np
    if _asr_model is not None and _tts_engine is not None:
        return

    import numpy as np
    from scipy.signal import resample_poly

    _np = np
    _resample_poly = resample_poly

    gpt_dir = str(CONFIG.get("gptSovitsDir") or "")
    if not gpt_dir or not os.path.isdir(gpt_dir):
        raise RuntimeError(f"Invalid gptSovitsDir: {gpt_dir}")
    sovits_weights = str(CONFIG.get("sovitsWeightsPath") or "")
    gpt_weights = str(CONFIG.get("gptWeightsPath") or "")
    ref_audio = str(CONFIG.get("refAudioPath") or "")
    if not os.path.isfile(sovits_weights):
        raise RuntimeError(f"Missing sovitsWeightsPath: {sovits_weights}")
    if not os.path.isfile(gpt_weights):
        raise RuntimeError(f"Missing gptWeightsPath: {gpt_weights}")
    if not os.path.isfile(ref_audio):
        raise RuntimeError(f"Missing refAudioPath: {ref_audio}")

    device = str(CONFIG.get("device") or "cuda")
    is_half = device != "cpu"
    os.environ.setdefault("is_half", "True" if is_half else "False")

    if _asr_model is None:
        from funasr import AutoModel

        models_root = os.path.join(gpt_dir, "tools", "asr", "models")
        asr_default = os.path.join(models_root, "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch")
        vad_default = os.path.join(models_root, "speech_fsmn_vad_zh-cn-16k-common-pytorch")
        punc_default = os.path.join(models_root, "punc_ct-transformer_zh-cn-common-vocab272727-pytorch")

        asr_model = CONFIG.get("asrModel") or (asr_default if os.path.isdir(asr_default) else "paraformer-zh")
        vad_model = CONFIG.get("vadModel") or (vad_default if os.path.isdir(vad_default) else None)
        punc_model = CONFIG.get("puncModel") or (punc_default if os.path.isdir(punc_default) else None)

        kwargs: dict = {
            "model": asr_model,
            "disable_update": True,
            "disable_pbar": True,
            "device": device,
        }
        if vad_model:
            kwargs["vad_model"] = vad_model
        if punc_model:
            kwargs["punc_model"] = punc_model
        _asr_model = AutoModel(**kwargs)

    if _tts_engine is None:
        os.chdir(gpt_dir)
        inner_dir = os.path.join(gpt_dir, "GPT_SoVITS")
        if gpt_dir not in sys.path:
            sys.path.insert(0, gpt_dir)
        if inner_dir not in sys.path:
            sys.path.insert(0, inner_dir)

        from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

        hubert_dir = os.path.join(inner_dir, "pretrained_models", "chinese-hubert-base")
        bert_dir = os.path.join(inner_dir, "pretrained_models", "chinese-roberta-wwm-ext-large")
        tts_cfg = TTS_Config({
            "custom": {
                "device": device,
                "is_half": is_half,
                "version": "v2ProPlus",
                "t2s_weights_path": gpt_weights,
                "vits_weights_path": sovits_weights,
                "cnhuhbert_base_path": hubert_dir,
                "bert_base_path": bert_dir,
            }
        })
        engine = TTS(tts_cfg)
        engine.set_ref_audio(ref_audio)
        _tts_engine = engine


def _handle_transcribe(msg: dict) -> dict:
    msg_id = msg.get("id")
    request_id = str(msg.get("requestId") or "")
    if request_id and request_id in _cancelled_ids:
        _cancelled_ids.discard(request_id)
        return {"id": msg_id, "ok": True, "text": "", "cancelled": True}

    raw_b64 = msg.get("audioBase64") or ""
    sample_rate = int(msg.get("sampleRate") or TARGET_ASR_RATE)
    pcm_bytes = base64.b64decode(raw_b64) if raw_b64 else b""
    if len(pcm_bytes) < 2:
        return {"id": msg_id, "ok": True, "text": ""}

    _ensure_models()
    assert _np is not None and _resample_poly is not None and _asr_model is not None

    audio_f32 = _np.frombuffer(pcm_bytes, dtype="<i2").astype(_np.float32) / 32768.0
    if sample_rate != TARGET_ASR_RATE and sample_rate > 0:
        g = math.gcd(TARGET_ASR_RATE, sample_rate)
        audio_f32 = _resample_poly(audio_f32, TARGET_ASR_RATE // g, sample_rate // g).astype(_np.float32)
    if audio_f32.shape[0] < 1600:
        return {"id": msg_id, "ok": True, "text": ""}

    res = _asr_model.generate(input=audio_f32, batch_size_s=300)
    raw_text = ""
    if isinstance(res, list) and res and isinstance(res[0], dict):
        raw_text = str(res[0].get("text") or "").strip()
    clean_text = re.sub(r"\s+", " ", raw_text).strip()
    if not clean_text or not re.search(r"[\w\u4e00-\u9fff]", clean_text):
        return {"id": msg_id, "ok": True, "text": ""}
    return {"id": msg_id, "ok": True, "text": clean_text}


def _handle_synthesize(msg: dict) -> dict:
    msg_id = msg.get("id")
    request_id = str(msg.get("requestId") or "")
    text = re.sub(r"\s+", " ", str(msg.get("text") or "")).strip()
    speed = float(msg.get("speed") or 1.0)
    if not (0.5 <= speed <= 1.5):
        speed = 1.0

    if request_id and request_id in _cancelled_ids:
        _cancelled_ids.discard(request_id)
        return {"id": msg_id, "ok": True, "sampleRate": TARGET_OUT_RATE, "chunksBase64": [], "cancelled": True}
    if not text or not re.search(r"[\w\u4e00-\u9fff]", text):
        return {"id": msg_id, "ok": True, "sampleRate": TARGET_OUT_RATE, "chunksBase64": []}

    _ensure_models()
    assert _np is not None and _resample_poly is not None and _tts_engine is not None

    ref_audio = str(CONFIG.get("refAudioPath") or "")
    ref_text = str(CONFIG.get("refText") or "")
    ref_lang = str(CONFIG.get("refLang") or "zh")
    text_lang = str(CONFIG.get("textLang") or "zh")

    parts = []
    source_sr = 32000
    gen = _tts_engine.run({
        "text": text,
        "text_lang": text_lang,
        "ref_audio_path": ref_audio,
        "prompt_text": ref_text,
        "prompt_lang": ref_lang,
        "top_k": 15,
        "top_p": 1.0,
        "temperature": 1.0,
        "text_split_method": "cut1",
        "batch_size": 1,
        "speed_factor": speed,
        "parallel_infer": True,
        "split_bucket": True,
        "return_fragment": False,
        "streaming_mode": False,
        "fragment_interval": 0.15,
    })
    for sr, chunk in gen:
        source_sr = int(sr)
        arr = _np.asarray(chunk).reshape(-1)
        if arr.size == 0:
            continue
        if _np.issubdtype(arr.dtype, _np.integer):
            arr = arr.astype(_np.float32) / 32768.0
        else:
            arr = arr.astype(_np.float32)
        parts.append(arr)

    if not parts:
        return {"id": msg_id, "ok": True, "sampleRate": TARGET_OUT_RATE, "chunksBase64": []}

    wave = _np.concatenate(parts)
    if source_sr != TARGET_OUT_RATE and source_sr > 0:
        g = math.gcd(TARGET_OUT_RATE, source_sr)
        wave = _resample_poly(wave, TARGET_OUT_RATE // g, source_sr // g).astype(_np.float32)

    pcm16 = _np.clip(_np.round(wave * 32767.0), -32768, 32767).astype("<i2").tobytes()
    chunks = [
        base64.b64encode(pcm16[i : i + CHUNK_BYTES]).decode("ascii")
        for i in range(0, len(pcm16), CHUNK_BYTES)
    ]
    return {"id": msg_id, "ok": True, "sampleRate": TARGET_OUT_RATE, "chunksBase64": chunks}


def main() -> None:
    emit({"type": "ready"})

    while True:
        raw = sys.stdin.buffer.readline()
        if not raw:
            return
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        if not isinstance(msg, dict):
            continue
        msg_id = msg.get("id")
        cmd = msg.get("cmd")
        req_id = msg.get("requestId")
        try:
            if cmd == "cancel":
                if isinstance(req_id, str) and req_id:
                    _cancelled_ids.add(req_id)
                emit({"id": msg_id, "ok": True, "cancelled": True})
            elif cmd == "warmup":
                _ensure_models()
                emit({"id": msg_id, "ok": True, "ready": True})
            elif cmd == "transcribe":
                emit(_handle_transcribe(msg))
            elif cmd == "synthesize":
                emit(_handle_synthesize(msg))
            else:
                emit({"id": msg_id, "ok": False, "error": f"unknown cmd: {cmd}"})
        except Exception as err:
            emit({"id": msg_id, "ok": False, "error": str(err)})
        finally:
            if cmd != "cancel" and isinstance(req_id, str) and req_id:
                _cancelled_ids.discard(req_id)


if __name__ == "__main__":
    main()
