"""
Philips Hue mood lighting manager & Hue button listener.
Commands:
  python apps/mood_lighting.py backup
  python apps/mood_lighting.py restore
  python apps/mood_lighting.py scene <name>
  python apps/mood_lighting.py buttons
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from hackroom import Room

SCENES = {
    "cyberpunk": {
        "spots": (255, 0, 128),     # Magenta / Neon Pink
        "strip_tv1": (0, 220, 255),  # Cyan
        "strip_tv2": (0, 220, 255),
        "brightness": 240,
    },
    "matrix": {
        "spots": (0, 255, 50),       # Toxic Green
        "strip_tv1": (0, 180, 20),
        "strip_tv2": (0, 180, 20),
        "brightness": 200,
    },
    "sunset": {
        "spots": (255, 120, 20),     # Golden Orange
        "strip_tv1": (255, 40, 0),   # Deep Red
        "strip_tv2": (255, 40, 0),
        "brightness": 220,
    },
    "calm_blue": {
        "spots": (0, 100, 255),      # Ocean Blue
        "strip_tv1": (50, 180, 255),
        "strip_tv2": (50, 180, 255),
        "brightness": 180,
    },
    "warm_white": {
        "spots": (255, 230, 180),
        "strip_tv1": (255, 230, 180),
        "strip_tv2": (255, 230, 180),
        "brightness": 220,
    },
}


def apply_scene(room: Room, scene_name: str):
    scene = SCENES.get(scene_name.lower())
    if not scene:
        print(f"Unknown scene '{scene_name}'. Available: {', '.join(SCENES.keys())}")
        return

    print(f"Applying scene '{scene_name}'...")
    bri = scene["brightness"]
    room.lights.set_spots_rgb(*scene["spots"], brightness=bri, transitiontime=10)
    room.lights.set_tv_strips_rgb(scene["strip_tv1"], scene["strip_tv2"], brightness=bri, transitiontime=10)
    print("Scene applied successfully.")


def listen_buttons(room: Room):
    print("Connecting to Hue Button Event Stream (SSE)...")
    print("Press any physical Hue button in the room to see events. Ctrl+C to exit.")

    def on_event(item):
        btn = item.get("button", {})
        btn_type = btn.get("last_event", "unknown")
        print(f"Hue Button Event: {btn_type} | ID: {item.get('id')}")

    try:
        room.lights.listen_buttons(on_event)
    except KeyboardInterrupt:
        print("\nStopped listening.")


def main():
    parser = argparse.ArgumentParser(description="Philips Hue lighting manager")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # backup
    subparsers.add_parser("backup", help="Save current light state before your slot starts")

    # restore
    subparsers.add_parser("restore", help="Restore light state after your slot ends")

    # scene
    scene_parser = subparsers.add_parser("scene", help="Set room mood scene")
    scene_parser.add_argument("name", choices=list(SCENES.keys()), help="Scene name")

    # buttons
    subparsers.add_parser("buttons", help="Listen for Hue button press events in real time")

    args = parser.parse_args()
    room = Room()

    if args.command == "backup":
        backup_file = "lights_backup.json"
        room.lights.backup_state(backup_file)
        print(f"Backed up room lights state to {backup_file}")
    elif args.command == "restore":
        backup_file = "lights_backup.json"
        if not os.path.exists(backup_file):
            print(f"Error: {backup_file} not found. Run backup first!")
            return
        room.lights.restore_state(backup_file)
        print("Restored lights state successfully.")
    elif args.command == "scene":
        apply_scene(room, args.name)
    elif args.command == "buttons":
        listen_buttons(room)


if __name__ == "__main__":
    main()
