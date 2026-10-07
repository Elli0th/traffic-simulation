"""
Coordinate calibration utilities for mapping between sensors (Lidar, Camera)
and display outputs (Projector pixels, TV pixels).
"""

import json
import math
import os
from typing import List, Optional, Tuple, Union
import cv2
import numpy as np


class HomographyTransform:
    """
    Handles 2D planar perspective transformations using a 3x3 Homography matrix.
    Used for Camera Pixels -> Projector Pixels, or Lidar mm -> Projector Pixels.
    """

    def __init__(self, matrix: Optional[np.ndarray] = None):
        if matrix is not None:
            self.matrix = np.array(matrix, dtype=np.float64)
        else:
            self.matrix = np.eye(3, dtype=np.float64)

    @classmethod
    def fit(cls, src_points: np.ndarray, dst_points: np.ndarray) -> "HomographyTransform":
        """
        Computes the optimal homography matrix mapping src_points to dst_points.
        Requires at least 4 corresponding point pairs.
        """
        src = np.array(src_points, dtype=np.float32).reshape(-1, 1, 2)
        dst = np.array(dst_points, dtype=np.float32).reshape(-1, 1, 2)
        H, _ = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
        if H is None:
            raise ValueError("Failed to compute homography from points")
        return cls(H)

    def transform_point(self, x: float, y: float) -> Tuple[float, float]:
        """Maps a single (x, y) point to destination space."""
        pt = np.array([[[x, y]]], dtype=np.float32)
        dst_pt = cv2.perspectiveTransform(pt, self.matrix)
        return float(dst_pt[0, 0, 0]), float(dst_pt[0, 0, 1])

    def transform_points(self, points: np.ndarray) -> np.ndarray:
        """
        Maps an (N, 2) numpy array of points to destination space.
        """
        if len(points) == 0:
            return np.empty((0, 2), dtype=np.float32)
        pts = np.array(points, dtype=np.float32).reshape(-1, 1, 2)
        dst_pts = cv2.perspectiveTransform(pts, self.matrix)
        return dst_pts.reshape(-1, 2)

    def save(self, filepath: str):
        """Saves matrix to JSON."""
        data = {"matrix": self.matrix.tolist()}
        with open(filepath, "w") as f:
            json.dump(data, f, indent=2)

    @classmethod
    def load(cls, filepath: str) -> "HomographyTransform":
        """Loads matrix from JSON."""
        with open(filepath, "r") as f:
            data = json.load(f)
        return cls(np.array(data["matrix"], dtype=np.float64))


class LidarProjectorMapper:
    """
    Parametric or homography mapper from Lidar mm (x, y) to Projector pixels (u, v).
    Default parameters derived from the room specification:
      - Projector: 1920 x 1200 pixels
      - Table: 1500 mm x 1500 mm
      - Projected band: ~1550 mm x 970 mm centered across the table.
      - Lidar: Middle of back edge (x=0, y=0).
    """

    def __init__(
        self,
        center_x_px: float = 960.0,
        center_y_px: float = 600.0,
        scale_x: float = 1.25,     # pixels per mm
        scale_y: float = 1.25,     # pixels per mm
        y_offset_mm: float = 600.0, # distance from back edge to center of projected area
        flip_x: bool = True,
        rotation_deg: float = 0.0,
        homography: Optional[HomographyTransform] = None,
    ):
        self.center_x_px = center_x_px
        self.center_y_px = center_y_px
        self.scale_x = scale_x
        self.scale_y = scale_y
        self.y_offset_mm = y_offset_mm
        self.flip_x = flip_x
        self.rotation_deg = rotation_deg
        self.homography = homography

    def lidar_to_projector(self, x_mm: float, y_mm: float) -> Tuple[int, int]:
        """
        Converts Lidar coordinates (mm) into Projector pixels (0..1919, 0..1199).
        """
        if self.homography is not None:
            px, py = self.homography.transform_point(x_mm, y_mm)
            return int(round(px)), int(round(py))

        # Rotate if angle offset
        rot_rad = math.radians(self.rotation_deg)
        rx = math.cos(rot_rad) * x_mm - math.sin(rot_rad) * y_mm
        ry = math.sin(rot_rad) * x_mm + math.cos(rot_rad) * y_mm

        # Relative to projected area center
        dx = -rx if self.flip_x else rx
        dy = ry - self.y_offset_mm

        px = self.center_x_px + dx * self.scale_x
        py = self.center_y_px + dy * self.scale_y

        return int(round(px)), int(round(py))

    def save(self, filepath: str = "lidar_calibration.json"):
        data = {
            "center_x_px": self.center_x_px,
            "center_y_px": self.center_y_px,
            "scale_x": self.scale_x,
            "scale_y": self.scale_y,
            "y_offset_mm": self.y_offset_mm,
            "flip_x": self.flip_x,
            "rotation_deg": self.rotation_deg,
        }
        if self.homography is not None:
            data["homography"] = self.homography.matrix.tolist()
        with open(filepath, "w") as f:
            json.dump(data, f, indent=2)

    @classmethod
    def load(cls, filepath: str = "lidar_calibration.json") -> "LidarProjectorMapper":
        with open(filepath, "r") as f:
            data = json.load(f)
        homo = None
        if "homography" in data:
            homo = HomographyTransform(np.array(data["homography"], dtype=np.float64))
        return cls(
            center_x_px=data.get("center_x_px", 960.0),
            center_y_px=data.get("center_y_px", 600.0),
            scale_x=data.get("scale_x", 1.25),
            scale_y=data.get("scale_y", 1.25),
            y_offset_mm=data.get("y_offset_mm", 600.0),
            flip_x=data.get("flip_x", True),
            rotation_deg=data.get("rotation_deg", 0.0),
            homography=homo,
        )
