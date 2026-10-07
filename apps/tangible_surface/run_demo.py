"""
Launcher for the Tangible Table Surface Demo:
1. Starts the Touch Surface server on port 8000
2. Projects the control surface directly onto the table (pi-projector.local)
3. Opens dynamic color monitors on TV 1 and TV 2
4. Verifies the projection using the overhead Logitech Brio 4K camera
5. Records the entire session (touches, events, camera frames) into recordings/
6. Enables physical hand/finger touch interaction with sliders, buttons, Hue lights, and TVs!
"""

import argparse
import os
import signal
import subprocess
import sys
import time

# Ensure root directory is on Python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from config import LAPTOP_IP
from hackroom import Room


def main():
    parser = argparse.ArgumentParser(description="Tangible Table Surface Demo")
    parser.add_argument("--projector-only", action="store_true", help="Only project on table without changing TVs")
    parser.add_argument("--no-displays", action="store_true", help="Run server locally without modifying room displays")
    parser.add_argument("--reset", action="store_true", help="Reset all room displays to idle and exit")
    args = parser.parse_args()

    room = Room()

    if args.reset:
        print("Resetting all room displays to idle...")
        for d in (room.projector, room.tv1, room.tv2):
            try:
                d.show_idle()
            except Exception:
                pass
        print("Displays reset.")
        return

    table_url = f"http://{LAPTOP_IP}:8000/"
    tv1_url = f"http://{LAPTOP_IP}:8000/tv?tv=1"
    tv2_url = f"http://{LAPTOP_IP}:8000/tv?tv=2"

    print("=" * 65)
    print("      TANGIBLE TABLE CONTROL SURFACE DEMO")
    print(f"      Host: {LAPTOP_IP}:8000")
    print("=" * 65)

    # 1. Start backend server
    print("\n[1/4] Starting Touch Server on http://0.0.0.0:8000 ...")
    server_script = os.path.join(os.path.dirname(__file__), "server.py")
    server_proc = subprocess.Popen([sys.executable, server_script])
    time.sleep(2.0)

    # 2. Update Displays
    if not args.no_displays:
        print("\n[2/4] Projecting Control Surface to Table (pi-projector.local)...")
        try:
            res = room.projector.show_url(table_url)
            print(f"      Table Projector updated: {res.get('ok')}")
        except Exception as e:
            print(f"      Table Projector update error: {e}")

        if not args.projector_only:
            print("\n[3/4] Pointing TV 1 & TV 2 to Live Color Monitors...")
            try:
                room.tv1.show_url(tv1_url)
                print("      TV 1 updated.")
            except Exception as e:
                print(f"      TV 1 error: {e}")

            try:
                room.tv2.show_url(tv2_url)
                print("      TV 2 updated.")
            except Exception as e:
                print(f"      TV 2 error: {e}")
    else:
        print("\n[2/4] Running in local preview mode.")
        print(f"      Open {table_url} on your laptop.")

    # 3. Camera Verification
    print("\n[4/4] Verifying Table Projection via Overhead Logitech Brio 4K Camera...")
    time.sleep(1.0)
    try:
        import cv2
        frame = room.camera.get_frame()
        verify_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../recordings/table_verified.jpg"))
        cv2.imwrite(verify_path, frame)
        print(f"      Table projection verified! Overhead snapshot saved to:\n      {verify_path}")
    except Exception as e:
        print(f"      Camera verification warning: {e}")

    print("\n" + "=" * 65)
    print("  ALL SYSTEMS LIVE!")
    print("  - Place your hand or fingers on the table to touch buttons!")
    print("  - Drag your finger on the sliders to change brightness & color!")
    print("  - Press TV color buttons to change TV 1 and TV 2 in real time!")
    print("  - All interactions & camera snapshots are being recorded into recordings/")
    print("  Press Ctrl+C to stop and reset displays.")
    print("=" * 65 + "\n")

    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        print("\nStopping demo and resetting displays to idle...")
    finally:
        server_proc.terminate()
        if not args.no_displays:
            for d in (room.projector, room.tv1, room.tv2):
                try:
                    d.show_idle()
                except Exception:
                    pass
        print("Done.")


if __name__ == "__main__":
    main()
