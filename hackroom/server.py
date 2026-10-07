"""
Local HTTP Web Server utility to serve HTML5 canvases, dashboards, and assets
from this laptop to the room displays (TV 1, TV 2, Projector) with automatic IP binding.
"""

from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
import os
import threading
import time
from typing import Optional
from config import LAPTOP_IP, DEFAULT_SERVER_PORT


class RoomHTTPRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable CORS so displays can fetch anything without restriction
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def log_message(self, format, *args):
        # Suppress noisy HTTP request logging
        pass


class WebDashboardServer:
    """
    Hosts a local folder over HTTP bound to 0.0.0.0 so the room's Pis can load it.
    """

    def __init__(self, directory: str, port: int = DEFAULT_SERVER_PORT, host_ip: Optional[str] = None):
        self.directory = os.path.abspath(directory)
        self.port = port
        self.host_ip = host_ip or LAPTOP_IP
        self._server: Optional[HTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self._running = False

    def get_url(self, path: str = "/") -> str:
        """Returns the fully qualified URL accessible by the room displays."""
        rel = path.lstrip("/")
        return f"http://{self.host_ip}:{self.port}/{rel}"

    def start(self):
        """Starts the server in a background daemon thread."""
        if self._running:
            return

        handler = partial(RoomHTTPRequestHandler, directory=self.directory)
        self._server = HTTPServer(("0.0.0.0", self.port), handler)
        self._running = True

        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        time.sleep(0.1)

    def stop(self):
        """Stops the server."""
        if self._server:
            self._server.shutdown()
            self._server.server_close()
        self._running = False

    def display_on(self, display_client, path: str = "/") -> dict:
        """
        Ensures the server is running and instructs the display client to show this page.
        """
        if not self._running:
            self.start()
        url = self.get_url(path)
        return display_client.show_url(url)

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.stop()
