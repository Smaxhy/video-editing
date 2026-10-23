#!/usr/bin/env python3
"""ClipForge footage analysis: shot changes (PySceneDetect), face positions and subject tracking (OpenCV).

Usage: analyze.py VIDEO [--shots] [--faces] [--faces-fps N] [--track] [--yunet MODEL.onnx]
Prints one JSON object to stdout:
  {"shots": [cut_seconds, ...], "faces": [{"t": sec, "x": 0-1, "y": 0-1, "s": 0-1}, ...],
   "errors": {"shots": "...", "faces": "..."}}
x/y are the face centre as a fraction of the frame; s is face width / frame width.
"track" (4 samples/s) follows the subject for smart reframing: the main face (YuNet when the model
is given, else a Haar cascade), otherwise the centre of the action (motion energy + fine detail):
  [{"t": sec, "x": 0-1, "y": 0-1, "s": size or spread 0-1, "k": "face" | "motion"}, ...]
Each feature fails independently, so a missing library never breaks the other one.
"""
import argparse
import json
import sys


def detect_shots(path):
    from scenedetect import AdaptiveDetector, detect

    scenes = detect(path, AdaptiveDetector(), show_progress=False)
    # Each scene is (start, end); the cut points are every start after the first.
    secs = lambda tc: tc.seconds if hasattr(type(tc), "seconds") else tc.get_seconds()  # noqa: E731
    return [round(secs(start), 3) for start, _end in scenes[1:]]


def detect_faces(path, sample_fps=2.0):
    import cv2

    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(cascade_path)
    if cascade.empty():
        raise RuntimeError("OpenCV face model missing (install opencv-python-headless<5)")

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError("could not open video")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(fps / sample_fps)))
    out = []
    index = 0
    while True:
        if not cap.grab():
            break
        if index % step == 0:
            ok, frame = cap.retrieve()
            if ok:
                h, w = frame.shape[:2]
                # ~960px keeps faces in wide shots big enough for the detector.
                scale = 960.0 / max(w, h)
                small = cv2.resize(frame, (int(w * scale), int(h * scale))) if scale < 1 else frame
                gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
                sh, sw = gray.shape[:2]
                found = cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=5, minSize=(20, 20))
                if len(found):
                    x, y, fw, fh = max(found, key=lambda r: r[2] * r[3])  # largest face = main speaker
                    out.append({
                        "t": round(index / fps, 2),
                        "x": round((x + fw / 2) / sw, 4),
                        "y": round((y + fh / 2) / sh, 4),
                        "s": round(fw / sw, 4),
                    })
        index += 1
    cap.release()
    return out


def track_subject(path, sample_fps=4.0, yunet=None):
    import os
    import cv2
    import numpy as np

    det = None
    if yunet and os.path.exists(yunet):
        det = cv2.FaceDetectorYN.create(yunet, "", (320, 320), 0.75, 0.3, 50)
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError("could not open video")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(fps / sample_fps)))
    out = []
    prev = None
    index = 0
    while True:
        if not cap.grab():
            break
        if index % step == 0:
            ok, frame = cap.retrieve()
            if ok:
                h0, w0 = frame.shape[:2]
                scale = 384.0 / w0
                small = cv2.resize(frame, (384, max(2, int(h0 * scale))))
                h, w = small.shape[:2]
                t = round(index / fps, 2)
                face = None
                if det is not None:
                    det.setInputSize((w, h))
                    _, found = det.detect(small)
                    if found is not None and len(found):
                        x, y, fw, fh = max(found, key=lambda r: r[2] * r[3])[:4]
                        face = (x + fw / 2, y + fh / 2, fw)
                elif not cascade.empty():
                    g = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
                    found = cascade.detectMultiScale(g, scaleFactor=1.08, minNeighbors=5, minSize=(18, 18))
                    if len(found):
                        x, y, fw, fh = max(found, key=lambda r: r[2] * r[3])
                        face = (x + fw / 2, y + fh / 2, fw)
                gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0)
                if face:
                    out.append({"t": t, "x": round(face[0] / w, 4), "y": round(face[1] / h, 4), "s": round(face[2] / w, 4), "k": "face"})
                else:
                    # Where the action is: moving pixels, plus a little weight on fine detail so a static
                    # subject (a trunk, a tool) still pulls the frame toward it.
                    energy = np.abs(cv2.Laplacian(gray, cv2.CV_32F)) * 0.15
                    if prev is not None:
                        diff = cv2.absdiff(gray, prev).astype(np.float32)
                        diff[diff < 14] = 0
                        energy = energy + diff
                    total = float(energy.sum())
                    if total > w * h * 1.5:
                        xs = np.arange(w, dtype=np.float32)
                        ys = np.arange(h, dtype=np.float32)
                        col = energy.sum(axis=0)
                        row = energy.sum(axis=1)
                        cx = float((col * xs).sum() / total)
                        cy = float((row * ys).sum() / total)
                        spread = float(np.sqrt((col * (xs - cx) ** 2).sum() / total)) / w
                        out.append({"t": t, "x": round(cx / w, 4), "y": round(cy / h, 4), "s": round(spread, 4), "k": "motion"})
                prev = gray
        index += 1
    cap.release()
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--shots", action="store_true")
    p.add_argument("--faces", action="store_true")
    p.add_argument("--faces-fps", type=float, default=2.0)
    p.add_argument("--track", action="store_true")
    p.add_argument("--yunet", default=None)
    a = p.parse_args()

    result = {"errors": {}}
    if a.shots:
        try:
            result["shots"] = detect_shots(a.video)
        except Exception as e:  # noqa: BLE001 — report, don't crash
            result["errors"]["shots"] = f"{type(e).__name__}: {e}"
    if a.faces:
        try:
            result["faces"] = detect_faces(a.video, a.faces_fps)
        except Exception as e:  # noqa: BLE001
            result["errors"]["faces"] = f"{type(e).__name__}: {e}"
    if a.track:
        try:
            result["track"] = track_subject(a.video, 4.0, a.yunet)
        except Exception as e:  # noqa: BLE001
            result["errors"]["track"] = f"{type(e).__name__}: {e}"
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
