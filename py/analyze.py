#!/usr/bin/env python3
"""ClipForge footage analysis: shot changes (PySceneDetect) and face positions (OpenCV).

Usage: analyze.py VIDEO [--shots] [--faces] [--faces-fps N]
Prints one JSON object to stdout:
  {"shots": [cut_seconds, ...], "faces": [{"t": sec, "x": 0-1, "y": 0-1, "s": 0-1}, ...],
   "errors": {"shots": "...", "faces": "..."}}
x/y are the face centre as a fraction of the frame; s is face width / frame width.
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


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--shots", action="store_true")
    p.add_argument("--faces", action="store_true")
    p.add_argument("--faces-fps", type=float, default=2.0)
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
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
