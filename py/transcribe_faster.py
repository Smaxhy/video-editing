#!/usr/bin/env python3
"""faster-whisper transcription that writes the same files as the openai-whisper CLI.

Usage: transcribe_faster.py VIDEO --model medium --output_dir DIR [--language en] [--device auto]
Writes DIR/<stem>.{json,srt,vtt,txt,tsv}; the JSON matches openai-whisper's shape
({"text", "language", "segments": [{"start","end","text","words":[{"word","start","end"}]}]}).
Prints tqdm-style "NN%|" progress lines on stderr.
"""
import argparse
import json
import os
import sys

MODEL_ALIASES = {"large": "large-v3", "turbo": "large-v3-turbo"}


def ts(t, sep):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--model", default="medium")
    p.add_argument("--output_dir", required=True)
    p.add_argument("--language", default=None)
    p.add_argument("--device", default="auto")
    a = p.parse_args()

    from faster_whisper import WhisperModel

    device = a.device
    if device == "auto":
        try:
            import ctranslate2

            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:  # noqa: BLE001
            device = "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    model = WhisperModel(MODEL_ALIASES.get(a.model, a.model), device=device, compute_type=compute_type)

    segments_iter, info = model.transcribe(
        a.video, language=a.language, word_timestamps=True, vad_filter=True, beam_size=5
    )
    duration = max(info.duration or 0.0, 0.001)
    segments = []
    last_pct = -1
    for seg in segments_iter:
        words = [
            {"word": w.word, "start": round(w.start, 3), "end": round(w.end, 3)}
            for w in (seg.words or [])
        ]
        segments.append({
            "id": len(segments),
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": seg.text,
            "words": words,
        })
        pct = min(100, int(seg.end / duration * 100))
        if pct != last_pct:
            sys.stderr.write(f"\r{pct:3d}%|\n")
            sys.stderr.flush()
            last_pct = pct

    stem = os.path.splitext(os.path.basename(a.video))[0]
    os.makedirs(a.output_dir, exist_ok=True)
    out = lambda ext: os.path.join(a.output_dir, f"{stem}.{ext}")  # noqa: E731
    text = "".join(s["text"] for s in segments)
    with open(out("json"), "w") as f:
        json.dump({"text": text, "language": info.language, "segments": segments}, f)
    with open(out("srt"), "w") as f:
        for i, s in enumerate(segments, 1):
            f.write(f"{i}\n{ts(s['start'], ',')} --> {ts(s['end'], ',')}\n{s['text'].strip()}\n\n")
    with open(out("vtt"), "w") as f:
        f.write("WEBVTT\n\n")
        for s in segments:
            f.write(f"{ts(s['start'], '.')} --> {ts(s['end'], '.')}\n{s['text'].strip()}\n\n")
    with open(out("txt"), "w") as f:
        f.write("\n".join(s["text"].strip() for s in segments) + "\n")
    with open(out("tsv"), "w") as f:
        f.write("start\tend\ttext\n")
        for s in segments:
            f.write(f"{int(s['start'] * 1000)}\t{int(s['end'] * 1000)}\t{s['text'].strip()}\n")
    sys.stderr.write("100%|\n")


if __name__ == "__main__":
    main()
