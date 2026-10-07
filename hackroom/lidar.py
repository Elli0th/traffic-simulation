"""
Lidar client for Slamtec RPLIDAR C1 (pi-lidar).
Handles WebSocket scan streaming, polar-to-Cartesian conversion, table filtering,
and Euclidean clustering for touch/object detection.
"""

import asyncio
from dataclasses import dataclass, field
import json
import math
import queue
import threading
from typing import AsyncGenerator, Generator, List, Optional, Tuple
import requests
import websockets
import numpy as np


@dataclass
class LidarPoint:
    angle_deg: float
    distance_mm: float
    quality: int
    x_mm: float
    y_mm: float


@dataclass
class TouchCluster:
    x_mm: float
    y_mm: float
    radius_mm: float
    point_count: int
    points: List[Tuple[float, float]] = field(default_factory=list)


@dataclass
class LidarScan:
    timestamp_ms: int
    points: List[LidarPoint]

    def to_numpy(self) -> np.ndarray:
        """Returns (N, 2) array of (x, y) coordinates in millimetres."""
        if not self.points:
            return np.empty((0, 2), dtype=np.float32)
        return np.array([[p.x_mm, p.y_mm] for p in self.points], dtype=np.float32)

    def filter_table(
        self,
        x_min: float = -750.0,
        x_max: float = 750.0,
        y_min: float = 0.0,
        y_max: float = 1500.0,
        min_quality: int = 10,
    ) -> "LidarScan":
        """
        Filters points to a rectangular table bounding box and minimum quality.
        Default bounding box corresponds to 1.5m x 1.5m table with lidar at (0, 0) on the back edge.
        """
        filtered = [
            p for p in self.points
            if p.quality >= min_quality
            and x_min <= p.x_mm <= x_max
            and y_min <= p.y_mm <= y_max
        ]
        return LidarScan(timestamp_ms=self.timestamp_ms, points=filtered)

    def detect_touches(
        self,
        cluster_distance_mm: float = 65.0,
        min_cluster_points: int = 3,
        max_cluster_points: int = 120,
    ) -> List[TouchCluster]:
        """
        Performs Euclidean clustering on points to detect fingertips, hands, or objects on the table.
        Returns a list of TouchCluster instances.
        """
        pts = self.to_numpy()
        if len(pts) < min_cluster_points:
            return []

        # Simple and fast greedy spatial clustering
        n = len(pts)
        visited = np.zeros(n, dtype=bool)
        clusters: List[TouchCluster] = []

        for i in range(n):
            if visited[i]:
                continue
            
            # Start new cluster
            current_cluster_indices = [i]
            visited[i] = True
            queue_idx = 0

            while queue_idx < len(current_cluster_indices):
                curr = current_cluster_indices[queue_idx]
                curr_pt = pts[curr]
                queue_idx += 1

                # Find unvisited neighbors within cluster_distance_mm
                dists = np.hypot(pts[:, 0] - curr_pt[0], pts[:, 1] - curr_pt[1])
                neighbors = np.where((~visited) & (dists <= cluster_distance_mm))[0]
                for neighbor in neighbors:
                    visited[neighbor] = True
                    current_cluster_indices.append(neighbor)

            if min_cluster_points <= len(current_cluster_indices) <= max_cluster_points:
                cluster_pts = pts[current_cluster_indices]
                cx = float(np.mean(cluster_pts[:, 0]))
                cy = float(np.mean(cluster_pts[:, 1]))
                radius = float(np.max(np.hypot(cluster_pts[:, 0] - cx, cluster_pts[:, 1] - cy)))
                clusters.append(
                    TouchCluster(
                        x_mm=cx,
                        y_mm=cy,
                        radius_mm=radius,
                        point_count=len(cluster_pts),
                        points=[(float(p[0]), float(p[1])) for p in cluster_pts],
                    )
                )

        return clusters


class LidarClient:
    """
    Client for streaming and processing RPLIDAR C1 scans from pi-lidar.
    """

    def __init__(
        self,
        base_url: str = "http://192.168.42.24",
        ws_url: str = "ws://192.168.42.24/scan",
        rotation_offset_deg: float = 0.0,
        flip_x: bool = False,
    ):
        self.base_url = base_url.rstrip("/")
        self.ws_url = ws_url
        self.rotation_offset_deg = rotation_offset_deg
        self.flip_x = flip_x

    def get_status(self) -> dict:
        """Queries pi-lidar /status for rps, point count, and hardware health."""
        resp = requests.get(f"{self.base_url}/status", timeout=3.0)
        resp.raise_for_status()
        return resp.json()

    def _parse_scan(self, raw_json: str) -> LidarScan:
        data = json.loads(raw_json)
        ts = data.get("t", 0)
        raw_points = data.get("points", [])

        parsed_points: List[LidarPoint] = []
        rot_rad = math.radians(self.rotation_offset_deg)
        flip_sign = -1.0 if self.flip_x else 1.0

        for p in raw_points:
            dist = float(p.get("distance", 0))
            if dist <= 0:
                continue

            angle = float(p.get("angle", 0.0))
            qual = int(p.get("quality", 0))

            # Angle is clockwise from above:
            # 0 deg points forward along the Y axis
            rad = math.radians(angle) + rot_rad
            x = flip_sign * math.sin(rad) * dist
            y = math.cos(rad) * dist

            parsed_points.append(
                LidarPoint(
                    angle_deg=angle,
                    distance_mm=dist,
                    quality=qual,
                    x_mm=x,
                    y_mm=y,
                )
            )

        return LidarScan(timestamp_ms=ts, points=parsed_points)

    async def stream_async(self) -> AsyncGenerator[LidarScan, None]:
        """
        Asynchronously streams live LidarScan instances via WebSocket.
        """
        async with websockets.connect(self.ws_url) as ws:
            while True:
                msg = await ws.recv()
                if isinstance(msg, bytes):
                    msg = msg.decode("utf-8")
                yield self._parse_scan(msg)

    def stream_sync(self) -> Generator[LidarScan, None, None]:
        """
        Synchronously yields live LidarScan instances using a background thread and queue.
        Example:
            for scan in lidar.stream_sync():
                touches = scan.detect_touches()
                print(f"Touches: {len(touches)}")
        """
        q: queue.Queue = queue.Queue(maxsize=5)
        stop_event = threading.Event()

        def _worker():
            async def _run():
                async with websockets.connect(self.ws_url) as ws:
                    while not stop_event.is_set():
                        msg = await ws.recv()
                        if isinstance(msg, bytes):
                            msg = msg.decode("utf-8")
                        scan = self._parse_scan(msg)
                        if q.full():
                            try:
                                q.get_nowait()
                            except queue.Empty:
                                pass
                        q.put(scan)

            asyncio.run(_run())

        thread = threading.Thread(target=_worker, daemon=True)
        thread.start()

        try:
            while True:
                try:
                    yield q.get(timeout=1.0)
                except queue.Empty:
                    continue
        finally:
            stop_event.set()
            thread.join(timeout=0.5)

    def __repr__(self) -> str:
        return f"<LidarClient at {self.ws_url}>"
