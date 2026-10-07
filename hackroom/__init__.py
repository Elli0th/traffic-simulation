"""
Hackroom SDK: High-performance Python framework for Aixia Hackathon Room.
"""

from hackroom.client import Room
from hackroom.display import DisplayClient, DisplayStreamer
from hackroom.camera import CameraClient
from hackroom.lidar import LidarClient, LidarScan, LidarPoint, TouchCluster
from hackroom.lights import HueClient, rgb_to_xy
from hackroom.calibration import LidarProjectorMapper, HomographyTransform
from hackroom.server import WebDashboardServer

__all__ = [
    "Room",
    "DisplayClient",
    "DisplayStreamer",
    "CameraClient",
    "LidarClient",
    "LidarScan",
    "LidarPoint",
    "TouchCluster",
    "HueClient",
    "rgb_to_xy",
    "LidarProjectorMapper",
    "HomographyTransform",
    "WebDashboardServer",
]
