"""
Camera client for the Logitech Brio 4K mounted next to the projector.
Provides single-frame capture, MJPEG OpenCV streaming, ROI cropping, and camera controls.
"""

from typing import Generator, List, Optional, Tuple, Union
import cv2
import numpy as np
import requests


class CameraClient:
    """
    Client for interacting with the Logitech Brio camera served by pi-projector.
    """

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    def _build_roi_param(self, roi: Optional[Union[str, Tuple[float, float, float, float], List[float]]]) -> Optional[str]:
        if roi is None:
            return None
        if isinstance(roi, str):
            return roi
        if isinstance(roi, (tuple, list)) and len(roi) == 4:
            return f"{roi[0]:.4f},{roi[1]:.4f},{roi[2]:.4f},{roi[3]:.4f}"
        raise ValueError("ROI must be a name string (e.g. 'table') or a 4-tuple of fractions (x, y, w, h).")

    def get_stream_url(self, roi: Optional[Union[str, Tuple[float, float, float, float], List[float]]] = None) -> str:
        """
        Returns the MJPEG stream URL, optionally cropped to an ROI.
        Can be used directly in cv2.VideoCapture or <img src="...">.
        """
        url = f"{self.base_url}/camera/stream"
        roi_str = self._build_roi_param(roi)
        if roi_str:
            url += f"?roi={roi_str}"
        return url

    def get_frame(self, roi: Optional[Union[str, Tuple[float, float, float, float], List[float]]] = None) -> np.ndarray:
        """
        Fetches the newest camera frame as a decoded OpenCV BGR image (np.ndarray).
        """
        url = f"{self.base_url}/camera/frame"
        roi_str = self._build_roi_param(roi)
        params = {"roi": roi_str} if roi_str else None

        resp = requests.get(url, params=params, timeout=5.0)
        resp.raise_for_status()

        img_array = np.frombuffer(resp.content, dtype=np.uint8)
        frame = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("Failed to decode camera JPEG bytes into an image array")
        return frame

    def get_frame_bytes(self, roi: Optional[Union[str, Tuple[float, float, float, float], List[float]]] = None) -> bytes:
        """
        Fetches the newest camera frame as raw JPEG bytes.
        """
        url = f"{self.base_url}/camera/frame"
        roi_str = self._build_roi_param(roi)
        params = {"roi": roi_str} if roi_str else None

        resp = requests.get(url, params=params, timeout=5.0)
        resp.raise_for_status()
        return resp.content

    def open_stream(self, roi: Optional[Union[str, Tuple[float, float, float, float], List[float]]] = None) -> cv2.VideoCapture:
        """
        Opens an OpenCV VideoCapture connected to the MJPEG stream.
        """
        url = self.get_stream_url(roi)
        cap = cv2.VideoCapture(url)
        if not cap.isOpened():
            raise RuntimeError(f"Failed to open video capture stream at {url}")
        return cap

    def stream(
        self,
        roi: Optional[Union[str, Tuple[float, float, float, float], List[float]]] = None,
    ) -> Generator[np.ndarray, None, None]:
        """
        Generator yielding frames from the live camera stream.
        Example:
            for frame in camera.stream(roi="table"):
                cv2.imshow("Stream", frame)
                if cv2.waitKey(1) == 27:
                    break
        """
        cap = self.open_stream(roi)
        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    break
                yield frame
        finally:
            cap.release()

    def set_mode(self, resolution: str) -> dict:
        """
        Switches camera mode: '720p' (60 fps), '1080p' (60 fps, default), or '4k' (30 fps).
        """
        res = resolution.lower()
        if res not in ("720p", "1080p", "4k"):
            raise ValueError("Resolution must be '720p', '1080p', or '4k'")

        resp = requests.post(f"{self.base_url}/camera/mode", json={"resolution": res}, timeout=5.0)
        resp.raise_for_status()
        return resp.json()

    def set_controls(
        self,
        auto: Optional[bool] = None,
        lock: Optional[bool] = None,
        field_of_view: Optional[int] = None,
        **custom_controls,
    ) -> dict:
        """
        Updates camera controls (auto, lock, fov 65/78/90, manual exposure, etc.).
        """
        payload = {}
        if auto is not None:
            payload["auto"] = auto
        if lock is not None:
            payload["lock"] = lock
        if field_of_view is not None:
            payload["field_of_view"] = field_of_view
        payload.update(custom_controls)

        resp = requests.post(f"{self.base_url}/camera/controls", json=payload, timeout=5.0)
        resp.raise_for_status()
        return resp.json()

    def reset(self) -> dict:
        """Resets camera to defaults: 1080p, auto exposure/focus/white-balance."""
        resp = requests.post(f"{self.base_url}/camera/reset", timeout=5.0)
        resp.raise_for_status()
        return resp.json()

    def save_roi(self, name: str, x: float, y: float, w: float, h: float) -> dict:
        """
        Saves a named ROI (e.g. 'table') on the camera server.
        Coordinates are fractions between 0.0 and 1.0.
        """
        payload = {"name": name, "roi": [x, y, w, h]}
        resp = requests.post(f"{self.base_url}/camera/roi", json=payload, timeout=5.0)
        resp.raise_for_status()
        return resp.json()

    def list_rois(self) -> dict:
        """Lists all registered named ROIs."""
        resp = requests.get(f"{self.base_url}/camera/roi", timeout=3.0)
        resp.raise_for_status()
        return resp.json()

    def get_status(self) -> dict:
        """Fetches camera status, current fps, mode, active readers."""
        resp = requests.get(f"{self.base_url}/camera/status", timeout=3.0)
        resp.raise_for_status()
        return resp.json()

    def __repr__(self) -> str:
        return f"<CameraClient at {self.base_url}>"
