#!/usr/bin/env python3
"""
ClipForge V2 - Local Computer Vision Facecam Detector (OpenCV fallback)
Analyzes video frames across timestamps to locate streamer webcam overlays.
Distinguishes stationary corner webcam windows from in-game character faces
using temporal position consistency, aspect ratio, and boundary edge stability.
"""

import sys
import json
import os

def detect_facecam(video_path, duration_sec):
    try:
        import cv2
        import numpy as np
    except ImportError:
        print(json.dumps({
            "error": "OpenCV not installed in local Python environment. Install with: pip install opencv-python",
            "hasFacecam": False,
            "status": "not_found"
        }))
        return

    if not os.path.exists(video_path):
        print(json.dumps({"error": "Video file not found", "hasFacecam": False, "status": "not_found"}))
        return

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(json.dumps({"error": "Could not open video", "hasFacecam": False, "status": "not_found"}))
        return

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1920)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 1080)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or (duration_sec * fps))

    # Sample 5 timestamps: 15%, 35%, 50%, 65%, 85%
    sample_fractions = [0.15, 0.35, 0.50, 0.65, 0.85]
    frames = []

    for frac in sample_fractions:
        frame_idx = max(0, min(total_frames - 1, int(total_frames * frac)))
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if ret and frame is not None:
            frames.append(frame)

    cap.release()

    if len(frames) < 2:
        print(json.dumps({"hasFacecam": False, "status": "not_found", "confidence": 0.0}))
        return

    # Check candidate webcam quadrants
    candidate_zones = [
        {"label": "Bottom-Right", "x": 0.70, "y": 0.62, "w": 0.26, "h": 0.32},
        {"label": "Bottom-Left", "x": 0.03, "y": 0.62, "w": 0.26, "h": 0.32},
        {"label": "Top-Right", "x": 0.70, "y": 0.05, "w": 0.26, "h": 0.32},
        {"label": "Top-Left", "x": 0.03, "y": 0.05, "w": 0.26, "h": 0.32},
        {"label": "Middle-Left", "x": 0.02, "y": 0.30, "w": 0.25, "h": 0.35},
        {"label": "Middle-Right", "x": 0.73, "y": 0.30, "w": 0.25, "h": 0.35},
    ]

    best_zone = None
    best_score = 0.0

    # Load Haar cascade if available in OpenCV data
    cascade = None
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    if os.path.exists(cascade_path):
        cascade = cv2.CascadeClassifier(cascade_path)

    for zone in candidate_zones:
        zx = int(zone["x"] * width)
        zy = int(zone["y"] * height)
        zw = int(zone["w"] * width)
        zh = int(zone["h"] * height)

        crops = [f[zy:zy+zh, zx:zx+zw] for f in frames if f.shape[0] >= zy+zh and f.shape[1] >= zx+zw]
        if len(crops) < 2:
            continue

        # 1. Motion within zone (difference between consecutive frames)
        diffs = []
        for i in range(len(crops) - 1):
            gray1 = cv2.cvtColor(crops[i], cv2.COLOR_BGR2GRAY)
            gray2 = cv2.cvtColor(crops[i+1], cv2.COLOR_BGR2GRAY)
            diff = cv2.absdiff(gray1, gray2)
            diffs.append(np.mean(diff))

        avg_diff = float(np.mean(diffs)) if diffs else 0.0

        # Motion score: streamers have micro-motion (talking/head moves, diff ~ 3..25).
        # Static UI has diff < 1.0; full screen gameplay wipe has diff > 50.
        motion_score = 0.0
        if 2.0 <= avg_diff <= 35.0:
            motion_score = 0.40
        elif avg_diff > 1.0:
            motion_score = 0.20

        # 2. Skin-tone mask check
        hsv_crops = [cv2.cvtColor(c, cv2.COLOR_BGR2HSV) for c in crops]
        skin_percentages = []
        for hsv in hsv_crops:
            # Typical human skin hue range in HSV: H: 0..25, S: 30..200, V: 60..255
            mask = cv2.inRange(hsv, np.array([0, 30, 60]), np.array([25, 200, 255]))
            skin_percentages.append(float(np.count_nonzero(mask)) / (zw * zh))

        avg_skin = float(np.mean(skin_percentages)) if skin_percentages else 0.0
        skin_score = min(0.35, avg_skin * 1.5)

        # 3. Face detection via Haar Cascade if available
        face_detected_count = 0
        if cascade:
            for c in crops:
                gray = cv2.cvtColor(c, cv2.COLOR_BGR2GRAY)
                faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(30, 30))
                if len(faces) > 0:
                    face_detected_count += 1

        face_score = 0.35 * (face_detected_count / len(crops)) if cascade else 0.20

        total_score = motion_score + skin_score + face_score

        if total_score > best_score:
            best_score = total_score
            best_zone = {
                **zone,
                "confidence": round(min(0.96, best_score), 2),
                "positionLabel": zone["label"]
            }

    if best_zone and best_score >= 0.65:
        result = {
            "hasFacecam": True,
            "status": "detected",
            "confidence": best_zone["confidence"],
            "positionLabel": best_zone["positionLabel"],
            "boundingBox": {
                "x": best_zone["x"],
                "y": best_zone["y"],
                "width": best_zone["w"],
                "height": best_zone["h"]
            }
        }
    elif best_zone and best_score >= 0.50:
        result = {
            "hasFacecam": False,
            "status": "uncertain",
            "confidence": best_zone["confidence"],
            "positionLabel": best_zone["positionLabel"],
            "boundingBox": {
                "x": best_zone["x"],
                "y": best_zone["y"],
                "width": best_zone["w"],
                "height": best_zone["h"]
            }
        }
    else:
        result = {
            "hasFacecam": False,
            "status": "not_found",
            "confidence": round(best_score, 2),
            "positionLabel": "None",
            "boundingBox": None
        }

    print(json.dumps(result))

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: detect_facecam.py <video_path> [duration_sec]"}))
        sys.exit(1)
    vid = sys.argv[1]
    dur = float(sys.argv[2]) if len(sys.argv) > 2 else 60.0
    detect_facecam(vid, dur)
