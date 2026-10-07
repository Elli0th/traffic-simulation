"""
Display client for TV 1, TV 2, and the Projector.
Handles /show commands (URL, image, blank, idle) and WebSocket /frames video streaming.
"""

import io
import json
import queue
import threading
import time
from typing import Optional, Tuple, Union
import urllib.request
import urllib.error

import cv2
import numpy as np
import requests
import websockets
import asyncio


class DisplayStreamer:
    """
    Background worker that streams OpenCV frames to ws://<display>/frames
    without blocking the user's main thread.
    """

    def __init__(
        self,
        ws_url: str,
        target_resolution: Optional[Tuple[int, int]] = None,
        target_fps: int = 30,
        jpeg_quality: int = 75,
    ):
        self.ws_url = ws_url
        self.target_resolution = target_resolution
        self.target_fps = target_fps
        self.jpeg_quality = jpeg_quality

        self._queue: queue.Queue = queue.Queue(maxsize=2)
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def start(self):
        """Starts the background streaming thread."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def stop(self):
        """Stops the streaming thread."""
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)

    def send_frame(self, frame: np.ndarray):
        """
        Enqueues a BGR numpy image frame to be streamed.
        Drops oldest frame if queue is full to ensure zero latency.
        """
        if not self._running:
            self.start()

        if self._queue.full():
            try:
                self._queue.get_nowait()
            except queue.Empty:
                pass
        self._queue.put(frame)

    def _run_loop(self):
        asyncio.run(self._async_sender())

    async def _async_sender(self):
        frame_interval = 1.0 / max(1, self.target_fps)

        while self._running:
            try:
                async with websockets.connect(self.ws_url) as ws:
                    last_send_time = time.time()
                    while self._running:
                        try:
                            # Non-blocking get with timeout
                            frame = self._queue.get(timeout=0.1)
                        except queue.Empty:
                            await asyncio.sleep(0.01)
                            continue

                        # Resize if needed
                        if self.target_resolution is not None:
                            h, w = frame.shape[:2]
                            target_w, target_h = self.target_resolution
                            if (w, h) != (target_w, target_h):
                                frame = cv2.resize(frame, (target_w, target_h), interpolation=cv2.INTER_AREA)

                        # Encode JPEG
                        encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), self.jpeg_quality]
                        ok, buf = cv2.imencode(".jpg", frame, encode_params)
                        if ok:
                            await ws.send(buf.tobytes())

                        # Frame rate pacing
                        elapsed = time.time() - last_send_time
                        sleep_time = frame_interval - elapsed
                        if sleep_time > 0:
                            await asyncio.sleep(sleep_time)
                        last_send_time = time.time()

            except Exception as e:
                # Reconnect after backoff if stream interrupted
                await asyncio.sleep(1.0)


class DisplayClient:
    """
    Client for controlling an Aixia room display (Raspberry Pi kiosk).
    """

    def __init__(
        self,
        name: str,
        base_url: str,
        native_resolution: Tuple[int, int] = (1920, 1080),
        stream_resolution: Tuple[int, int] = (1280, 720),
    ):
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.ws_url = f"{self.base_url.replace('http://', 'ws://').replace('https://', 'wss://')}/frames"
        self.native_resolution = native_resolution
        self.stream_resolution = stream_resolution

    def get_status(self) -> dict:
        """Fetches display status: mode, url, screen size, frame rate."""
        resp = requests.get(f"{self.base_url}/status", timeout=3.0)
        resp.raise_for_status()
        return resp.json()

    def show_url(self, url: str) -> dict:
        """
        Displays a web page at the given URL in the kiosk browser.
        Note: The URL must be accessible to the Pi (bind to 0.0.0.0 and use laptop room IP).
        """
        payload = {"url": url}
        resp = requests.post(f"{self.base_url}/show", json=payload, timeout=5.0)
        resp.raise_for_status()
        return resp.json()

    def show_image(self, image: Union[str, bytes, np.ndarray]) -> dict:
        """
        Displays a static image on the screen.
        Accepts:
          - str: file path
          - bytes: raw JPEG or PNG bytes
          - np.ndarray: OpenCV BGR image
        """
        url = f"{self.base_url}/show"

        if isinstance(image, str):
            # File path
            with open(image, "rb") as f:
                resp = requests.post(url, files={"file": f}, timeout=5.0)
        elif isinstance(image, np.ndarray):
            # Encode OpenCV frame to PNG
            ok, buf = cv2.imencode(".png", image)
            if not ok:
                raise ValueError("Failed to encode image to PNG format")
            resp = requests.post(url, data=buf.tobytes(), headers={"Content-Type": "image/png"}, timeout=5.0)
        elif isinstance(image, (bytes, bytearray)):
            resp = requests.post(url, data=image, headers={"Content-Type": "image/png"}, timeout=5.0)
        else:
            raise TypeError("Unsupported image type. Provide file path, bytes, or numpy.ndarray.")

        resp.raise_for_status()
        return resp.json()

    def show_blank(self) -> dict:
        """Blanks the display (shows black screen)."""
        resp = requests.post(f"{self.base_url}/show", json={"blank": True}, timeout=3.0)
        resp.raise_for_status()
        return resp.json()

    def show_idle(self) -> dict:
        """Returns the display to the default room idle screen."""
        resp = requests.post(f"{self.base_url}/show", json={"idle": True}, timeout=3.0)
        resp.raise_for_status()
        return resp.json()

    def create_streamer(
        self,
        fps: int = 30,
        quality: int = 75,
        resolution: Optional[Tuple[int, int]] = None,
    ) -> DisplayStreamer:
        """
        Creates and returns a DisplayStreamer instance for smooth, low-latency video streaming.
        Usage:
            streamer = display.create_streamer()
            streamer.start()
            while True:
                streamer.send_frame(my_cv2_frame)
        """
        target_res = resolution or self.stream_resolution
        return DisplayStreamer(
            ws_url=self.ws_url,
            target_resolution=target_res,
            target_fps=fps,
            jpeg_quality=quality,
        )

    def __repr__(self) -> str:
        return f"<DisplayClient {self.name} at {self.base_url} ({self.native_resolution[0]}x{self.native_resolution[1]})>"
