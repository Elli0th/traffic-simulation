"""
Logitech Brio 4K camera tracker:
Demonstrates ArUco marker detection, frame difference motion detection, and ROI capture.
"""

import argparse
import os
import sys
import time
import cv2
import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from hackroom import Room


def run_camera_tracker(use_roi: bool = False, detect_markers: bool = True, save_snapshot: bool = False):
    print("Initializing Room and Camera...")
    room = Room()
    roi = "table" if use_roi else None

    # Setup ArUco detector
    aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    parameters = cv2.aruco.DetectorParameters()
    detector = cv2.aruco.ArucoDetector(aruco_dict, parameters)

    if save_snapshot:
        print(f"Capturing single frame (ROI={roi})...")
        frame = room.camera.get_frame(roi=roi)
        out_path = "camera_snapshot.jpg"
        cv2.imwrite(out_path, frame)
        print(f"Saved snapshot to {out_path} ({frame.shape[1]}x{frame.shape[0]})")
        return

    print(f"Connecting to camera stream (ROI={roi})...")
    stream_url = room.camera.get_stream_url(roi=roi)
    cap = cv2.VideoCapture(stream_url)

    if not cap.isOpened():
        print(f"Failed to open camera stream at {stream_url}")
        return

    print("Reading frames... Press Ctrl+C to stop.")
    frame_count = 0
    start_time = time.time()

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("Stream ended or frame skipped.")
                time.sleep(0.05)
                continue

            frame_count += 1
            h, w = frame.shape[:2]

            # Detect ArUco markers if enabled
            if detect_markers:
                corners, ids, _ = detector.detectMarkers(frame)
                if ids is not None:
                    for marker_id, c in zip(ids.flatten(), corners):
                        cx, cy = c[0].mean(axis=0)
                        print(f"Frame #{frame_count}: ArUco Marker ID {marker_id} at ({cx:.1f}, {cy:.1f})")

            # Report FPS every 30 frames
            if frame_count % 30 == 0:
                elapsed = time.time() - start_time
                fps = frame_count / elapsed
                print(f"Read {frame_count} frames | Current FPS: {fps:.1f} | Frame Size: {w}x{h}")

    except KeyboardInterrupt:
        print("\nStopping camera tracker...")
    finally:
        cap.release()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Camera tracker for Logitech Brio")
    parser.add_argument("--roi", action="store_true", help="Crop stream to table ROI")
    parser.add_argument("--snapshot", action="store_true", help="Capture and save a single frame to disk")
    parser.add_argument("--no-markers", action="store_true", help="Disable ArUco marker detection")
    args = parser.parse_args()

    run_camera_tracker(use_roi=args.roi, detect_markers=not args.no_markers, save_snapshot=args.snapshot)
