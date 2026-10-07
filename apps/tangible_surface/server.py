"""
Backend server for the Tangible Table Touch Surface.
Runs FastAPI + WebSockets, ingests RPLIDAR C1 scans, detects touch collisions
with projected UI elements, controls Philips Hue & TVs, and records camera/lidar sessions.
"""

import asyncio
import base64
import json
import logging
import math
import os
import sys
import time
from typing import Dict, List, Optional
import cv2
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import numpy as np
import pydantic
import requests
import uvicorn
import websockets

# Ensure root directory is on Python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from config import LAPTOP_IP, LIDAR_WS, PROJECTOR_BASE
from hackroom import Room, LidarScan, TouchCluster

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("TangibleServer")

app = FastAPI()

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(CURRENT_DIR, "static")
RECORDINGS_DIR = os.path.abspath(os.path.join(CURRENT_DIR, "../../recordings"))
SNAPSHOTS_DIR = os.path.join(RECORDINGS_DIR, "snapshots")
os.makedirs(SNAPSHOTS_DIR, exist_ok=True)
LOG_FILE = os.path.join(RECORDINGS_DIR, "interaction_log.jsonl")

# Room controller instance
room = Room()

# Registered interactive UI elements from table frontend
registered_elements: List[dict] = []

# Connected WebSockets
table_clients: List[WebSocket] = []
tv_clients: Dict[str, List[WebSocket]] = {"1": [], "2": []}

# Interaction state & debouncing
last_action_times: Dict[str, float] = {}
current_brightness = 200
current_hue_deg = 200
current_room_color = (0, 180, 255)
camera_view_active = False


def log_event(event_type: str, details: dict):
    """Appends an event to the persistent session log."""
    entry = {
        "timestamp": time.time(),
        "time_str": time.strftime("%Y-%m-%d %H:%M:%S"),
        "type": event_type,
        **details,
    }
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def capture_camera_verification(reason: str = "auto") -> Optional[str]:
    """Captures an overhead camera frame, saves it, and logs verification."""
    try:
        frame = room.camera.get_frame()
        ts = int(time.time() * 1000)
        filename = f"snap_{ts}.jpg"
        filepath = os.path.join(SNAPSHOTS_DIR, filename)
        cv2.imwrite(filepath, frame)

        # Update latest verified file
        verified_path = os.path.join(RECORDINGS_DIR, "table_verified.jpg")
        cv2.imwrite(verified_path, frame)

        # Create thumbnail for web UI
        h, w = frame.shape[:2]
        thumb = cv2.resize(frame, (160, int(160 * h / w)))
        _, buf = cv2.imencode(".jpg", thumb, [cv2.IMWRITE_JPEG_QUALITY, 70])
        data_url = "data:image/jpeg;base64," + base64.b64encode(buf).decode("utf-8")

        log_event("camera_verification", {"reason": reason, "file": filename, "resolution": [w, h]})
        return data_url
    except Exception as e:
        logger.warning(f"Camera capture error: {e}")
        return None


# ==========================================
# HARDWARE ACTION HANDLERS
# ==========================================
async def execute_action(action_id: str):
    """Executes a hardware action (Hue lights / TVs) based on touch button."""
    global current_brightness, current_room_color
    logger.info(f"Triggering action: {action_id}")
    log_event("button_press", {"action_id": action_id})

    # Broadcast visual press to table UI
    await broadcast_to_table({"type": "action_triggered", "id": action_id})

    try:
        # Philips Hue Scenes
        if action_id == "scene_cyber":
            current_room_color = (255, 0, 128)
            room.lights.set_spots_rgb(255, 0, 128, brightness=current_brightness)
            room.lights.set_tv_strips_rgb((0, 220, 255), (0, 220, 255), brightness=current_brightness)
            await broadcast_to_tv("1", "#ff0080", "Cyber Pink")
            await broadcast_to_tv("2", "#00dcff", "Cyber Cyan")

        elif action_id == "scene_sunset":
            current_room_color = (255, 120, 20)
            room.lights.set_spots_rgb(255, 120, 20, brightness=current_brightness)
            room.lights.set_tv_strips_rgb((255, 30, 0), (255, 30, 0), brightness=current_brightness)
            await broadcast_to_tv("1", "#ff7814", "Sunset Amber")
            await broadcast_to_tv("2", "#ff1e00", "Sunset Crimson")

        elif action_id == "scene_matrix":
            current_room_color = (0, 255, 50)
            room.lights.set_spots_rgb(0, 255, 50, brightness=current_brightness)
            room.lights.set_tv_strips_rgb((0, 180, 20), (0, 180, 20), brightness=current_brightness)
            await broadcast_to_tv("1", "#00ff32", "Matrix Green")
            await broadcast_to_tv("2", "#00b414", "Matrix Forest")

        elif action_id == "scene_ocean":
            current_room_color = (0, 100, 255)
            room.lights.set_spots_rgb(0, 100, 255, brightness=current_brightness)
            room.lights.set_tv_strips_rgb((50, 200, 255), (50, 200, 255), brightness=current_brightness)
            await broadcast_to_tv("1", "#0064ff", "Ocean Blue")
            await broadcast_to_tv("2", "#32c8ff", "Ocean Cyan")

        elif action_id == "scene_white":
            current_room_color = (255, 230, 190)
            room.lights.set_spots_rgb(255, 230, 190, brightness=current_brightness)
            room.lights.set_tv_strips_rgb((255, 230, 190), (255, 230, 190), brightness=current_brightness)
            await broadcast_to_tv("1", "#ffffff", "Warm White")
            await broadcast_to_tv("2", "#ffffff", "Warm White")

        elif action_id == "scene_off":
            room.lights.turn_off_all()
            await broadcast_to_tv("1", "#000000", "Black")
            await broadcast_to_tv("2", "#000000", "Black")

        # TV 1 Buttons
        elif action_id == "tv1_red":
            await broadcast_to_tv("1", "#ef4444", "Vibrant Red")
        elif action_id == "tv1_blue":
            await broadcast_to_tv("1", "#3b82f6", "Vibrant Blue")
        elif action_id == "tv1_green":
            await broadcast_to_tv("1", "#10b981", "Vibrant Green")
        elif action_id == "tv1_amber":
            await broadcast_to_tv("1", "#f59e0b", "Warm Amber")

        # TV 2 Buttons
        elif action_id == "tv2_magenta":
            await broadcast_to_tv("2", "#ec4899", "Neon Magenta")
        elif action_id == "tv2_cyan":
            await broadcast_to_tv("2", "#06b6d4", "Electric Cyan")
        elif action_id == "tv2_purple":
            await broadcast_to_tv("2", "#8b5cf6", "Deep Purple")
        elif action_id == "tv2_white":
            await broadcast_to_tv("2", "#f8fafc", "Pure White")

        # Sync Both TVs
        elif action_id == "sync_tvs":
            hex_col = "#{:02x}{:02x}{:02x}".format(*current_room_color)
            await broadcast_to_tv("1", hex_col, "Synced")
            await broadcast_to_tv("2", hex_col, "Synced")

        # Toggle Camera Projection View
        elif action_id == "toggle_camera":
            global camera_view_active
            camera_view_active = not camera_view_active
            logger.info(f"Toggled Camera Projection View: {camera_view_active}")
            log_event("camera_view_toggle", {"active": camera_view_active})
            await broadcast_to_table({
                "type": "camera_view_toggled",
                "active": camera_view_active,
                "stream_url": "http://192.168.42.21/camera/stream"
            })

        # Verify Camera
        elif action_id == "verify_camera":
            d_url = capture_camera_verification(reason="manual_button")
            if d_url:
                await broadcast_to_table({"type": "camera_snapshot", "data_url": d_url})

    except Exception as e:
        logger.error(f"Action execution error: {e}")


async def execute_slider(slider_id: str, pct: float):
    """Executes a slider update (brightness or color spectrum)."""
    global current_brightness, current_hue_deg, current_room_color
    log_event("slider_touch", {"slider_id": slider_id, "pct": pct})
    await broadcast_to_table({"type": "slider_updated", "id": slider_id, "pct": pct})

    try:
        if slider_id == "bri":
            current_brightness = max(10, min(254, int(pct * 2.54)))
            room.lights.set_spots_rgb(*current_room_color, brightness=current_brightness, transitiontime=2)

        elif slider_id == "hue":
            current_hue_deg = float(pct) * 3.6  # 0 to 360 deg
            # Convert HSV hue to RGB
            h_rad = math.radians(current_hue_deg)
            r = int(127.5 * (1 + math.cos(h_rad)))
            g = int(127.5 * (1 + math.cos(h_rad - 2.094)))
            b = int(127.5 * (1 + math.cos(h_rad + 2.094)))
            current_room_color = (r, g, b)
            room.lights.set_spots_rgb(r, g, b, brightness=current_brightness, transitiontime=2)
            hex_col = f"#{r:02x}{g:02x}{b:02x}"
            await broadcast_to_tv("1", hex_col, "Custom Hue")
            await broadcast_to_tv("2", hex_col, "Custom Hue")

    except Exception as e:
        logger.error(f"Slider execution error: {e}")


async def broadcast_to_table(data: dict):
    for ws in list(table_clients):
        try:
            await ws.send_json(data)
        except Exception:
            table_clients.remove(ws)


async def broadcast_to_tv(tv_id: str, color_hex: str, color_name: str):
    log_event("tv_update", {"tv_id": tv_id, "color": color_hex, "name": color_name})
    for ws in list(tv_clients.get(tv_id, [])):
        try:
            await ws.send_json({"color": color_hex, "name": color_name})
        except Exception:
            tv_clients[tv_id].remove(ws)


# ==========================================
# FASTAPI ROUTES & WEBSOCKETS
# ==========================================
@app.get("/", response_class=HTMLResponse)
async def get_index():
    with open(os.path.join(STATIC_DIR, "index.html"), "r", encoding="utf-8") as f:
        return f.read()


@app.get("/tv", response_class=HTMLResponse)
async def get_tv():
    with open(os.path.join(STATIC_DIR, "tv.html"), "r", encoding="utf-8") as f:
        return f.read()


class ActionPayload(pydantic.BaseModel):
    action: str


@app.post("/api/action")
async def api_action(payload: ActionPayload):
    await execute_action(payload.action)
    return {"status": "ok", "action": payload.action}


class SliderPayload(pydantic.BaseModel):
    slider: str
    pct: float


@app.post("/api/slider")
async def api_slider(payload: SliderPayload):
    await execute_slider(payload.slider, payload.pct)
    return {"status": "ok", "slider": payload.slider, "pct": payload.pct}


@app.websocket("/ws/table")
async def ws_table(websocket: WebSocket):
    await websocket.accept()
    table_clients.append(websocket)
    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            if data.get("type") == "register_elements":
                global registered_elements
                registered_elements = data.get("elements", [])
                logger.info(f"Registered {len(registered_elements)} interactive table elements.")
    except WebSocketDisconnect:
        if websocket in table_clients:
            table_clients.remove(websocket)


@app.websocket("/ws/tv/{tv_id}")
async def ws_tv(websocket: WebSocket, tv_id: str):
    await websocket.accept()
    if tv_id in tv_clients:
        tv_clients[tv_id].append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        if tv_id in tv_clients and websocket in tv_clients[tv_id]:
            tv_clients[tv_id].remove(websocket)


# ==========================================
# LIDAR PROCESSING & COLLISION ENGINE
# ==========================================
async def lidar_loop():
    logger.info(f"Connecting to Lidar WebSocket at {LIDAR_WS} ...")
    proj_w, proj_h = 1920, 1200  # Projector native canvas
    last_cam_snap = time.time()

    while True:
        try:
            async with websockets.connect(LIDAR_WS) as ws:
                logger.info("Connected to RPLIDAR C1! Tracking table touches...")
                async for raw_msg in ws:
                    data = json.loads(raw_msg)
                    points = data.get("points", [])

                    # Parse points into Cartesian mm
                    parsed_pts = []
                    for p in points:
                        dist = float(p.get("distance", 0))
                        if dist < 100 or dist > 1500 or p.get("quality", 0) < 12:
                            continue
                        deg = float(p.get("angle", 0))
                        rad = math.radians(deg)
                        # Lidar at (0, 0) on back edge, 0 deg straight across
                        x_mm = math.sin(rad) * dist
                        y_mm = math.cos(rad) * dist

                        # Filter to table surface
                        if -750.0 <= x_mm <= 750.0 and 80.0 <= y_mm <= 1450.0:
                            parsed_pts.append((x_mm, y_mm))

                    if not parsed_pts:
                        continue

                    # Cluster points into discrete hand/finger touches
                    scan = LidarScan(
                        timestamp_ms=data.get("t", 0),
                        points=[
                            type("Pt", (), {"x_mm": pt[0], "y_mm": pt[1], "quality": 20})()
                            for pt in parsed_pts
                        ],
                    )
                    touches = scan.detect_touches(cluster_distance_mm=60.0, min_cluster_points=3)

                    # Periodic camera snapshot verification (every 6 seconds)
                    now = time.time()
                    if now - last_cam_snap > 6.0:
                        last_cam_snap = now
                        d_url = capture_camera_verification(reason="periodic_verify")
                        if d_url:
                            await broadcast_to_table({"type": "camera_snapshot", "data_url": d_url})

                    # Map touches to screen pixels and test collisions
                    for touch in touches:
                        # Physical Table -> Projector Pixels Mapping (Horizontally inverted):
                        # Width: -720mm to +720mm -> 0 to 1920 px (flipped)
                        # Depth: +180mm to +1150mm -> 0 to 1200 px
                        norm_u = 1.0 - ((touch.x_mm + 720.0) / 1440.0)
                        norm_v = (touch.y_mm - 180.0) / 970.0

                        px = int(round(norm_u * proj_w))
                        py = int(round(norm_v * proj_h))

                        if 0 <= px <= proj_w and 0 <= py <= proj_h:
                            hit_element = None

                            # Collision check against registered UI elements
                            for el in registered_elements:
                                ex, ey, ew, eh = el["x"], el["y"], el["w"], el["h"]
                                if ex <= px <= ex + ew and ey <= py <= ey + eh:
                                    hit_element = el
                                    break

                            # Broadcast touch ripple to UI
                            await broadcast_to_table({
                                "type": "touch",
                                "x": px,
                                "y": py,
                                "x_mm": round(touch.x_mm, 1),
                                "y_mm": round(touch.y_mm, 1),
                                "hit": hit_element is not None,
                                "action": hit_element["id"] if hit_element else None,
                            })

                            # Trigger action if collision
                            if hit_element:
                                el_id = hit_element["id"]
                                el_type = hit_element["type"]

                                if el_type == "button":
                                    last_hit = last_action_times.get(el_id, 0.0)
                                    if now - last_hit > 0.55:  # 550ms debounce
                                        last_action_times[el_id] = now
                                        asyncio.create_task(execute_action(el_id))

                                elif el_type == "slider":
                                    # Calculate slider percentage from finger X
                                    pct = max(0.0, min(100.0, ((px - hit_element["x"]) / hit_element["w"]) * 100.0))
                                    last_hit = last_action_times.get(el_id, 0.0)
                                    if now - last_hit > 0.12:  # 120ms throttle
                                        last_action_times[el_id] = now
                                        asyncio.create_task(execute_slider(el_id, pct))

        except Exception as e:
            logger.warning(f"Lidar connection error: {e}. Retrying in 2s...")
            await asyncio.sleep(2.0)


@app.on_event("startup")
async def startup_event():
    logger.info("Tangible surface server starting...")
    # Initial overhead camera verification snapshot
    capture_camera_verification(reason="server_startup")
    asyncio.create_task(lidar_loop())


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="warning")
