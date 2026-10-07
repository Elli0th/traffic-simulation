"""
Table Touch & Gesture Tracker:
Processes RPLIDAR C1 scans, detects touch points and hands on the table,
and renders real-time interactive visual feedback mapped to the projector display.
"""

import argparse
import sys
import os
import time
import cv2
import numpy as np

# Ensure root directory is on Python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from hackroom import Room, LidarProjectorMapper


def run_touch_tracker(stream_to_projector: bool = False, show_preview: bool = False):
    print("Initializing Room and Lidar Touch Tracker...")
    room = Room()
    mapper = LidarProjectorMapper()

    # Streaming setup for projector
    streamer = None
    if stream_to_projector:
        print("Starting WebSocket frame streamer to Projector...")
        streamer = room.projector.create_streamer(fps=30, quality=75)
        streamer.start()

    canvas_w, canvas_h = 1280, 800  # Optimal streaming resolution for 16:10
    active_ripples = []  # List of dicts for animated ripples: [{"x", "y", "radius", "alpha"}]

    print("Listening to Lidar scans on ws://pi-lidar.local/scan ...")
    print("Press Ctrl+C to stop.")

    try:
        last_frame_time = time.time()
        for scan in room.lidar.stream_sync():
            # 1. Filter points to table bounds
            table_scan = scan.filter_table(
                x_min=-750.0,
                x_max=750.0,
                y_min=50.0,
                y_max=1500.0,
                min_quality=12,
            )

            # 2. Detect touch clusters (fingers / hands / objects)
            touches = table_scan.detect_touches(
                cluster_distance_mm=60.0,
                min_cluster_points=3,
                max_cluster_points=100,
            )

            # Create render frame
            frame = np.zeros((canvas_h, canvas_w, 3), dtype=np.uint8)

            # Draw table boundary guide
            cv2.rectangle(frame, (10, 10), (canvas_w - 10, canvas_h - 10), (30, 30, 40), 1)

            # Add new touches to ripple animations
            for touch in touches:
                # Map from Lidar mm to Canvas pixels
                # Native projector is 1920x1200, scale to 1280x800
                proj_x, proj_y = mapper.lidar_to_projector(touch.x_mm, touch.y_mm)
                cx = int(proj_x * (canvas_w / 1920.0))
                cy = int(proj_y * (canvas_h / 1200.0))

                if 0 <= cx < canvas_w and 0 <= cy < canvas_h:
                    active_ripples.append({"x": cx, "y": cy, "r": 10, "alpha": 1.0})
                    print(f"Touch detected at Table ({touch.x_mm:+.0f}mm, {touch.y_mm:+.0f}mm) -> Pixel ({cx}, {cy})")

            # Update and draw animated ripples
            new_ripples = []
            for rip in active_ripples:
                color = (int(0 * rip["alpha"]), int(200 * rip["alpha"]), int(255 * rip["alpha"]))
                cv2.circle(frame, (rip["x"], rip["y"]), int(rip["r"]), color, 2)
                cv2.circle(frame, (rip["x"], rip["y"]), 4, (0, 255, 255), -1)

                rip["r"] += 3.5
                rip["alpha"] -= 0.05
                if rip["alpha"] > 0:
                    new_ripples.append(rip)
            active_ripples = new_ripples

            # Draw raw lidar points on table for visual alignment
            for p in table_scan.points:
                px, py = mapper.lidar_to_projector(p.x_mm, p.y_mm)
                cx = int(px * (canvas_w / 1920.0))
                cy = int(py * (canvas_h / 1200.0))
                if 0 <= cx < canvas_w and 0 <= cy < canvas_h:
                    cv2.circle(frame, (cx, cy), 1, (80, 80, 120), -1)

            # HUD Telemetry
            now = time.time()
            fps = 1.0 / max(0.001, (now - last_frame_time))
            last_frame_time = now
            cv2.putText(
                frame,
                f"Lidar Touches: {len(touches)} | Points: {len(table_scan.points)} | {fps:.1f} FPS",
                (20, 35),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 220, 255),
                1,
                cv2.LINE_AA,
            )

            # Stream to projector if enabled
            if streamer:
                streamer.send_frame(frame)

            # Show local OpenCV preview if enabled
            if show_preview:
                cv2.imshow("Table Touch Preview", frame)
                if cv2.waitKey(1) == 27:  # ESC to exit
                    break

    except KeyboardInterrupt:
        print("\nStopping tracker...")
    finally:
        if streamer:
            streamer.stop()
        if show_preview:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Lidar Table Touch and Gesture Tracker")
    parser.add_argument("--stream", action="store_true", help="Stream visual feedback to projector (use during slot)")
    parser.add_argument("--preview", action="store_true", help="Show local OpenCV window preview")
    args = parser.parse_args()

    run_touch_tracker(stream_to_projector=args.stream, show_preview=args.preview)
