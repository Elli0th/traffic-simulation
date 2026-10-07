"""
Master Orchestrator for Tangible Table Traffic Simulation:
Connects the Gothenburg traffic simulation to the Hackathon Room:
  - Table Projector: Top-down table view (1920x1200)
  - TV 1 & TV 2: Synchronized 3D flyover screen view (1920x1080)
  - RPLIDAR C1: Physical objects placed on the table close streets in real-time
  - Philips Hue Lights: Reactive lighting matching traffic congestion & emergency ambulances
"""

import argparse
import asyncio
import json
import logging
import os
import signal
import subprocess
import sys
import time
import threading
from typing import Dict, List, Optional
import requests
import websockets

# Ensure root directory is on Python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from config import LAPTOP_IP, ROOM_ENV
from hackroom import Room, LidarScan, TouchCluster

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("TrafficTable")

VITE_PORT = 5173
VITE_HOST = "0.0.0.0"
BASE_HTTP_URL = f"http://{LAPTOP_IP}:{VITE_PORT}"
VITE_WS_URL = f"ws://{LAPTOP_IP}:{VITE_PORT}"


class SimulationBridge:
    def __init__(
        self,
        room: Room,
        enable_lidar: bool = True,
        enable_lights: bool = True,
    ):
        self.room = room
        self.enable_lidar = enable_lidar
        self.enable_lights = enable_lights

        self.running = False
        self.ws_client = None
        self._last_light_update = 0.0
        self._light_mode = "calm"

    async def connect_vite_relay(self):
        """Connects to Vite's dev server WebSocket relay."""
        logger.info(f"Connecting to Vite WebSocket relay at {VITE_WS_URL} ...")
        while self.running:
            try:
                async with websockets.connect(VITE_WS_URL, subprotocols=["vite-hmr"]) as ws:
                    self.ws_client = ws
                    logger.info("Connected to Vite relay!")
                    
                    # Listen for simulation metrics
                    async for raw in ws:
                        if not self.running:
                            break
                        try:
                            msg = json.loads(raw)
                            if msg.get("type") == "custom" and msg.get("event") == "room:metrics":
                                self.handle_metrics(msg.get("data", {}))
                        except Exception:
                            pass
            except Exception as e:
                logger.warning(f"Vite relay disconnected ({e}). Retrying in 2s...")
                self.ws_client = None
                await asyncio.sleep(2.0)

    async def send_blobs(self, blobs: List[dict]):
        """Sends detected table obstacles (blobs) into Vite relay."""
        if self.ws_client:
            payload = {
                "type": "custom",
                "event": "room:blobs",
                "data": blobs,
            }
            try:
                await self.ws_client.send(json.dumps(payload))
            except Exception:
                self.ws_client = None

    def handle_metrics(self, metrics: dict):
        """Reacts to simulation metrics with Philips Hue lighting."""
        if not self.enable_lights:
            return

        now = time.time()
        if now - self._last_light_update < 0.6:
            return  # Throttle to avoid Hue bridge overload
        self._last_light_update = now

        congestion = metrics.get("congestion", 0.0)
        ambulance_delay = metrics.get("ambulanceDelay", 0.0)
        no_route = metrics.get("noRoute", False)

        try:
            # 1. Emergency condition (Ambulance blocked or delayed)
            if no_route or ambulance_delay > 0.15:
                if self._light_mode != "emergency":
                    self._light_mode = "emergency"
                    logger.info("Emergency vehicle alert! Flashing TV light strips...")
                    # Red & Blue emergency strips
                    self.room.lights.set_tv_strips_rgb((255, 0, 0), (0, 0, 255), brightness=254, transitiontime=2)
                    self.room.lights.set_spots_rgb(255, 30, 0, brightness=240, transitiontime=4)

            # 2. Heavy Congestion (> 50%)
            elif congestion > 0.50:
                if self._light_mode != "congested":
                    self._light_mode = "congested"
                    logger.info(f"Traffic congestion high ({congestion*100:.0f}%). Setting amber lights.")
                    self.room.lights.set_spots_rgb(255, 120, 10, brightness=220, transitiontime=8)
                    self.room.lights.set_tv_strips_rgb((255, 90, 0), (255, 90, 0), brightness=200, transitiontime=8)

            # 3. Smooth Traffic (< 50%)
            else:
                if self._light_mode != "calm":
                    self._light_mode = "calm"
                    logger.info(f"Traffic flowing smoothly ({congestion*100:.0f}%). Setting calm cyan lights.")
                    self.room.lights.set_spots_rgb(0, 180, 255, brightness=200, transitiontime=10)
                    self.room.lights.set_tv_strips_rgb((0, 220, 200), (0, 220, 200), brightness=180, transitiontime=10)
        except Exception as e:
            logger.debug(f"Hue update error: {e}")

    async def lidar_loop(self):
        """Streams Lidar scans, detects table touches, and sends them as obstacle blobs."""
        logger.info("Starting Lidar table touch loop...")
        last_sent = 0.0

        async for scan in self.room.lidar.stream_async():
            if not self.running:
                break

            # Filter points to physical table area (1.5 x 1.5 m)
            # Lidar sits at middle of back edge (x=0, y=0)
            table_scan = scan.filter_table(
                x_min=-750.0,
                x_max=750.0,
                y_min=50.0,
                y_max=1450.0,
                min_quality=12,
            )

            # Detect touch clusters (cups, fingers, objects)
            touches = table_scan.detect_touches(
                cluster_distance_mm=65.0,
                min_cluster_points=3,
                max_cluster_points=120,
            )

            # Map from Lidar millimetres to table fractions [0, 1]
            # Projected area is ~1550mm wide, 970mm deep, starting ~150mm from back edge
            blobs = []
            for t in touches:
                # Table coordinate conversion (0 to 1)
                u = (t.x_mm + 750.0) / 1500.0
                v = (t.y_mm - 100.0) / 1000.0

                if 0.0 <= u <= 1.0 and 0.0 <= v <= 1.0:
                    r = max(0.025, min(0.08, t.radius_mm / 1500.0))
                    blobs.append({"x": round(u, 4), "y": round(v, 4), "r": round(r, 4)})

            now = time.time()
            if blobs or (now - last_sent > 1.0):
                await self.send_blobs(blobs)
                last_sent = now

    async def run(self):
        self.running = True
        tasks = [asyncio.create_task(self.connect_vite_relay())]
        if self.enable_lidar:
            tasks.append(asyncio.create_task(self.lidar_loop()))
        await asyncio.gather(*tasks)

    def stop(self):
        self.running = False


def check_or_start_vite() -> Optional[subprocess.Popen]:
    """Ensures Vite dev server is running on port 5173."""
    try:
        resp = requests.get(f"http://127.0.0.1:{VITE_PORT}", timeout=1.0)
        if resp.status_code == 200:
            logger.info("Vite dev server is already running.")
            return None
    except Exception:
        pass

    logger.info("Starting Vite dev server...")
    node_cmd = r"C:\Program Files\nodejs\npm.cmd"
    sim_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "traffic-simulation"))
    
    env = os.environ.copy()
    env["Path"] = r"C:\Program Files\nodejs;" + env.get("Path", "")
    
    proc = subprocess.Popen(
        [node_cmd, "run", "dev", "--", "--host", VITE_HOST, "--port", str(VITE_PORT)],
        cwd=sim_dir,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(3.0)
    return proc


def show_on_displays(room: Room, target: str):
    table_url = f"{BASE_HTTP_URL}/?hud=0"
    screen_url = f"{BASE_HTTP_URL}/?view=screen"

    logger.info(f"Target display mode: {target}")

    if target in ("all", "projector"):
        logger.info(f"Pointing Table Projector to {table_url} ...")
        try:
            res = room.projector.show_url(table_url)
            logger.info(f"Projector updated: {res}")
        except Exception as e:
            logger.error(f"Projector update failed: {e}")

    if target in ("all", "tvs", "tv1"):
        logger.info(f"Pointing TV 1 to {screen_url} ...")
        try:
            res = room.tv1.show_url(screen_url)
            logger.info(f"TV 1 updated: {res}")
        except Exception as e:
            logger.error(f"TV 1 update failed: {e}")

    if target in ("all", "tvs", "tv2"):
        logger.info(f"Pointing TV 2 to {screen_url} ...")
        try:
            res = room.tv2.show_url(screen_url)
            logger.info(f"TV 2 updated: {res}")
        except Exception as e:
            logger.error(f"TV 2 update failed: {e}")


def reset_displays(room: Room):
    logger.info("Resetting displays to idle mode...")
    for disp in (room.projector, room.tv1, room.tv2):
        try:
            disp.show_idle()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description="Tangible Table Traffic Simulation Room Orchestrator")
    parser.add_argument(
        "--display",
        choices=["all", "projector", "tvs", "none"],
        default="none",
        help="Which room screens to take over (default: none, for safe testing outside your slot)",
    )
    parser.add_argument("--no-lidar", action="store_true", help="Disable automatic Lidar touch bridge")
    parser.add_argument("--no-lights", action="store_true", help="Disable reactive Hue lighting")
    parser.add_argument("--reset-only", action="store_true", help="Reset all displays to idle and exit")
    args = parser.parse_args()

    room = Room()

    if args.reset_only:
        reset_displays(room)
        return

    # 1. Start Vite if needed
    proc = check_or_start_vite()

    # 2. Point room displays
    if args.display != "none":
        show_on_displays(room, args.display)
    else:
        print("\n" + "=" * 65)
        print("  SIMULATION RUNNING IN DESK / PREVIEW MODE")
        print(f"  Table View:       {BASE_HTTP_URL}/")
        print(f"  TV 3D View:       {BASE_HTTP_URL}/?view=screen")
        print(f"  Lidar Calibrator: {BASE_HTTP_URL}/lidar.html")
        print("  To cast to the room during your slot, run with --display all")
        print("=" * 65 + "\n")

    # 3. Run Bridge
    bridge = SimulationBridge(
        room=room,
        enable_lidar=not args.no_lidar,
        enable_lights=not args.no_lights and (args.display != "none"),
    )

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def handle_signal():
        logger.info("Shutting down...")
        bridge.stop()
        if args.display != "none":
            reset_displays(room)
        if proc:
            proc.terminate()
        loop.stop()

    try:
        loop.run_until_complete(bridge.run())
    except KeyboardInterrupt:
        handle_signal()
    finally:
        bridge.stop()
        if args.display != "none":
            reset_displays(room)


if __name__ == "__main__":
    main()
