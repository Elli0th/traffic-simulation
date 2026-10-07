"""
Unified room controller for AIXIA Hackathon.
Provides instant access to all room sensors and displays.
"""

from typing import Dict, Optional
import time
from config import (
    ROOM_ENV,
    LAPTOP_IP,
    PROJECTOR_BASE,
    TV1_BASE,
    TV2_BASE,
    LIDAR_HTTP,
    LIDAR_WS,
    HUE_BASE,
    HUE_HTTPS,
    HUE_USER,
    HUE_CLIENT_KEY,
    PROJECTOR_NATIVE_RES,
    PROJECTOR_STREAM_RES,
    TV1_NATIVE_RES,
    TV_STREAM_RES,
    TV2_NATIVE_RES,
    LIGHT_STRIP_TV1,
    LIGHT_STRIP_TV2,
    LIGHT_SPOTS,
    DEFAULT_SERVER_PORT,
)
from hackroom.display import DisplayClient
from hackroom.camera import CameraClient
from hackroom.lidar import LidarClient
from hackroom.lights import HueClient
from hackroom.calibration import LidarProjectorMapper
from hackroom.server import WebDashboardServer


class Room:
    """
    Main entry point for interacting with the Aixia room.
    Usage:
        from hackroom import Room
        room = Room()
        frame = room.camera.get_frame()
        room.lights.set_spots_rgb(0, 150, 255)
    """

    def __init__(self, env: Optional[str] = None):
        self.env = env or ROOM_ENV

        # Displays
        self.projector = DisplayClient(
            name="projector",
            base_url=PROJECTOR_BASE,
            native_resolution=PROJECTOR_NATIVE_RES,
            stream_resolution=PROJECTOR_STREAM_RES,
        )
        self.tv1 = DisplayClient(
            name="tv-1",
            base_url=TV1_BASE,
            native_resolution=TV1_NATIVE_RES,
            stream_resolution=TV_STREAM_RES,
        )
        self.tv2 = DisplayClient(
            name="tv-2",
            base_url=TV2_BASE,
            native_resolution=TV2_NATIVE_RES,
            stream_resolution=TV_STREAM_RES,
        )

        # Sensors
        self.camera = CameraClient(base_url=PROJECTOR_BASE)
        self.lidar = LidarClient(base_url=LIDAR_HTTP, ws_url=LIDAR_WS)

        # Lights
        self.lights = HueClient(
            base_url=HUE_BASE,
            https_url=HUE_HTTPS,
            user=HUE_USER,
            client_key=HUE_CLIENT_KEY,
            strip_tv1_id=LIGHT_STRIP_TV1,
            strip_tv2_id=LIGHT_STRIP_TV2,
            spot_ids=LIGHT_SPOTS,
        )

        # Calibration
        self.calibration = LidarProjectorMapper()

    def create_server(self, directory: str, port: int = DEFAULT_SERVER_PORT) -> WebDashboardServer:
        """Creates a local web server for displaying custom web pages on the screens."""
        return WebDashboardServer(directory=directory, port=port, host_ip=LAPTOP_IP)

    def diagnose(self) -> Dict[str, dict]:
        """
        Runs a quick health check and latency test against all room devices.
        Returns a dictionary summarizing status and response times.
        """
        results = {}

        # 1. Projector display
        t0 = time.time()
        try:
            p_stat = self.projector.get_status()
            results["projector"] = {"status": "ok", "latency_ms": round((time.time() - t0) * 1000, 1), "details": p_stat}
        except Exception as e:
            results["projector"] = {"status": "error", "error": str(e)}

        # 2. TV 1
        t0 = time.time()
        try:
            tv1_stat = self.tv1.get_status()
            results["tv1"] = {"status": "ok", "latency_ms": round((time.time() - t0) * 1000, 1), "details": tv1_stat}
        except Exception as e:
            results["tv1"] = {"status": "error", "error": str(e)}

        # 3. TV 2
        t0 = time.time()
        try:
            tv2_stat = self.tv2.get_status()
            results["tv2"] = {"status": "ok", "latency_ms": round((time.time() - t0) * 1000, 1), "details": tv2_stat}
        except Exception as e:
            results["tv2"] = {"status": "error", "error": str(e)}

        # 4. Camera
        t0 = time.time()
        try:
            cam_stat = self.camera.get_status()
            results["camera"] = {"status": "ok", "latency_ms": round((time.time() - t0) * 1000, 1), "details": cam_stat}
        except Exception as e:
            results["camera"] = {"status": "error", "error": str(e)}

        # 5. Lidar
        t0 = time.time()
        try:
            lidar_stat = self.lidar.get_status()
            results["lidar"] = {"status": "ok", "latency_ms": round((time.time() - t0) * 1000, 1), "details": lidar_stat}
        except Exception as e:
            results["lidar"] = {"status": "error", "error": str(e)}

        # 6. Hue bridge
        t0 = time.time()
        try:
            lights = self.lights.get_all_lights()
            results["lights"] = {
                "status": "ok",
                "latency_ms": round((time.time() - t0) * 1000, 1),
                "light_count": len(lights),
                "names": [v.get("name") for v in lights.values()],
            }
        except Exception as e:
            results["lights"] = {"status": "error", "error": str(e)}

        return results
