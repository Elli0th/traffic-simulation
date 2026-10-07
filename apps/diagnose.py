"""
Comprehensive diagnostic CLI for the AIXIA Hackathon Room.
Checks network reachability, API health, frame rates, and latency for every device.
"""

import sys
import os
# Ensure root directory is on Python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from config import LAPTOP_IP, ROOM_ENV
from hackroom import Room


def print_banner():
    print("=" * 65)
    print("        AIXIA HACKATHON ROOM - DEVICE DIAGNOSTIC")
    print(f"        Environment: {ROOM_ENV.upper()} | Laptop IP: {LAPTOP_IP}")
    print("=" * 65)


def run_diagnostics():
    print_banner()
    room = Room()
    print("Testing device endpoints...\n")

    diag = room.diagnose()

    # 1. Projector
    p = diag.get("projector", {})
    p_stat = p.get("status")
    p_lat = p.get("latency_ms", "N/A")
    screen = p.get("details", {}).get("screen", ["?", "?"])
    print(f"[{'PASS' if p_stat == 'ok' else 'FAIL'}] Projector (pi-projector.local):")
    print(f"       Status: {p_stat} ({p_lat} ms)")
    print(f"       Resolution: {screen[0]}x{screen[1]} | Mode: {p.get('details', {}).get('mode')}")

    # 2. TV 1
    tv1 = diag.get("tv1", {})
    tv1_stat = tv1.get("status")
    tv1_lat = tv1.get("latency_ms", "N/A")
    s1 = tv1.get("details", {}).get("screen", ["?", "?"])
    print(f"[{'PASS' if tv1_stat == 'ok' else 'FAIL'}] TV 1 (pi-tv-1.local):")
    print(f"       Status: {tv1_stat} ({tv1_lat} ms)")
    print(f"       Resolution: {s1[0]}x{s1[1]} | Mode: {tv1.get('details', {}).get('mode')}")

    # 3. TV 2
    tv2 = diag.get("tv2", {})
    tv2_stat = tv2.get("status")
    tv2_lat = tv2.get("latency_ms", "N/A")
    s2 = tv2.get("details", {}).get("screen", ["?", "?"])
    print(f"[{'PASS' if tv2_stat == 'ok' else 'FAIL'}] TV 2 (pi-tv-2.local):")
    print(f"       Status: {tv2_stat} ({tv2_lat} ms)")
    print(f"       Resolution: {s2[0]}x{s2[1]} | Mode: {tv2.get('details', {}).get('mode')}")

    # 4. Camera
    cam = diag.get("camera", {})
    cam_stat = cam.get("status")
    cam_lat = cam.get("latency_ms", "N/A")
    cam_det = cam.get("details", {})
    print(f"[{'PASS' if cam_stat == 'ok' else 'FAIL'}] Camera (Logitech Brio 4K):")
    print(f"       Status: {cam_stat} ({cam_lat} ms)")
    print(f"       Mode: {cam_det.get('mode')} | FPS: {cam_det.get('fps')} | Target: {cam_det.get('target_fps')}")

    # 5. Lidar
    lidar = diag.get("lidar", {})
    l_stat = lidar.get("status")
    l_lat = lidar.get("latency_ms", "N/A")
    l_det = lidar.get("details", {})
    print(f"[{'PASS' if l_stat == 'ok' else 'FAIL'}] Lidar (Slamtec RPLIDAR C1):")
    print(f"       Status: {l_stat} ({l_lat} ms)")
    print(f"       RPS: {l_det.get('rotations_per_second')} | Points/Rot: {l_det.get('points_per_rotation')} | Health: {l_det.get('health', {}).get('status')}")

    # 6. Lights
    lights = diag.get("lights", {})
    lt_stat = lights.get("status")
    lt_lat = lights.get("latency_ms", "N/A")
    print(f"[{'PASS' if lt_stat == 'ok' else 'FAIL'}] Philips Hue Bridge:")
    print(f"       Status: {lt_stat} ({lt_lat} ms)")
    print(f"       Connected lights ({lights.get('light_count', 0)}): {', '.join(lights.get('names', []))}")

    print("\n" + "=" * 65)
    all_ok = all(d.get("status") == "ok" for d in diag.values())
    if all_ok:
        print("  ALL DEVICES OPERATIONAL AND READY!")
    else:
        print("  SOME DEVICES FAILED - Check cables / wifi connection.")
    print("=" * 65 + "\n")


if __name__ == "__main__":
    run_diagnostics()
