"""
Configuration for the AIXIA Hackathon Room devices and network.
Supports switching between the real room and the Docker simulator.
"""

import os
import socket
from typing import Tuple, List

# Environment: "real" or "sim"
ROOM_ENV = os.getenv("ROOM_ENV", "real").lower()

def get_laptop_ip(target_ip: str = "192.168.42.1") -> str:
    """
    Auto-detects the local IP address of this machine that reaches the room network.
    Falls back to '127.0.0.1' if disconnected.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Does not actually send data over UDP, just identifies routing interface
        s.connect((target_ip, 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


LAPTOP_IP = get_laptop_ip()

# ==========================================
# DEVICE URLS & ENDPOINTS
# ==========================================
if ROOM_ENV == "sim":
    PROJECTOR_BASE = "http://localhost:8021"
    TV1_BASE = "http://localhost:8022"
    TV2_BASE = "http://localhost:8023"
    LIDAR_HTTP = "http://localhost:8024"
    LIDAR_WS = "ws://localhost:8024/scan"
    HUE_BASE = "http://localhost:8011"
    HUE_HTTPS = "https://localhost:8443"
else:  # "real"
    PROJECTOR_BASE = "http://192.168.42.21"
    TV1_BASE = "http://192.168.42.22"
    TV2_BASE = "http://192.168.42.23"
    LIDAR_HTTP = "http://192.168.42.24"
    LIDAR_WS = "ws://192.168.42.24/scan"
    HUE_BASE = "http://192.168.42.11"
    HUE_HTTPS = "https://192.168.42.11"

# Hue bridge credentials
HUE_USER = "ckwwi95MBr7z3fnL-CwSbtfmlfOtjmLK9fGPPkCu"
HUE_CLIENT_KEY = "63966C84DB0E23061742F382EEB72402"

# Light mapping
LIGHT_STRIP_TV1 = 1
LIGHT_STRIP_TV2 = 8
LIGHT_SPOTS: List[int] = [2, 3, 4, 5, 6, 7]
ALL_LIGHT_IDS: List[int] = [1, 2, 3, 4, 5, 6, 7, 8]

# Native Screen resolutions (width, height)
PROJECTOR_NATIVE_RES: Tuple[int, int] = (1920, 1200)  # 16:10
TV1_NATIVE_RES: Tuple[int, int] = (1920, 1080)        # 16:9
TV2_NATIVE_RES: Tuple[int, int] = (1920, 1080)        # 16:9

# Optimal streaming resolutions over Wi-Fi
PROJECTOR_STREAM_RES: Tuple[int, int] = (1280, 800)   # 16:10
TV_STREAM_RES: Tuple[int, int] = (1280, 720)          # 16:9
DEFAULT_STREAM_FPS = 30
DEFAULT_JPEG_QUALITY = 75

# Table physical dimensions (in millimetres)
TABLE_WIDTH_MM = 1500
TABLE_DEPTH_MM = 1500
PROJECTED_WIDTH_MM = 1550
PROJECTED_DEPTH_MM = 970

# Aixia LLM Gateway
AIXIA_LLM_URL = "https://llm.aiqu.ai/v1"
AIXIA_LLM_KEY = os.getenv("AIXIA_LLM_KEY", "")

# Default local server port for serving web apps
DEFAULT_SERVER_PORT = 8000
