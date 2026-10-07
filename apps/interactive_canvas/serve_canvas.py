"""
Starts the local server and commands a room display (Projector or TVs)
to show the interactive canvas application.
Usage:
  python apps/interactive_canvas/serve_canvas.py                 # Shows on projector
  python apps/interactive_canvas/serve_canvas.py --target tv1    # Shows on TV 1
  python apps/interactive_canvas/serve_canvas.py --local-only    # Only serves locally on laptop
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))
from hackroom import Room, WebDashboardServer
from config import LAPTOP_IP, DEFAULT_SERVER_PORT


def main():
    parser = argparse.ArgumentParser(description="Serve Interactive Canvas to Room Displays")
    parser.add_argument("--port", type=int, default=DEFAULT_SERVER_PORT, help="Port to host web server on")
    parser.add_argument(
        "--target",
        choices=["projector", "tv1", "tv2", "local-only"],
        default="local-only",
        help="Target display (default: local-only so you don't take display outside your slot)",
    )
    args = parser.parse_args()

    app_dir = os.path.dirname(os.path.abspath(__file__))
    server = WebDashboardServer(directory=app_dir, port=args.port, host_ip=LAPTOP_IP)
    server.start()

    url = server.get_url("/index.html")
    print("=" * 60)
    print("  INTERACTIVE CANVAS SERVER STARTED")
    print(f"  Local / LAN URL: {url}")
    print("=" * 60)

    room = Room()

    if args.target == "local-only":
        print(f"\nServing locally. Open {url} in your laptop browser to preview.\n")
        print("To show on a display during your slot, run with:")
        print("  python apps/interactive_canvas/serve_canvas.py --target projector")
    else:
        display_map = {
            "projector": room.projector,
            "tv1": room.tv1,
            "tv2": room.tv2,
        }
        target_display = display_map[args.target]
        print(f"\nSending /show command to {target_display.name}...")
        try:
            res = target_display.show_url(url)
            print(f"Display {target_display.name} updated: {res}")
        except Exception as e:
            print(f"Error updating display: {e}")

    print("\nServer running. Press Ctrl+C to terminate...")
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        print("\nStopping server...")
    finally:
        server.stop()
        if args.target != "local-only":
            print(f"Resetting {args.target} to idle...")
            try:
                display_map[args.target].show_idle()
            except Exception:
                pass


if __name__ == "__main__":
    main()
