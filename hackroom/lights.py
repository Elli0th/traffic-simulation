"""
Philips Hue bridge client for the room lights (TV strips and table spots).
Includes RGB-to-xy color conversion, rate-limiting, backup/restore,
and Server-Sent Events (SSE) listener for Hue buttons.
"""

import json
import logging
import ssl
import time
import threading
from typing import Callable, Dict, List, Optional, Tuple, Union
import urllib.request
import urllib.error
import requests

logger = logging.getLogger(__name__)


def rgb_to_xy(r: int, g: int, b: int) -> Tuple[float, float]:
    """
    Converts 8-bit RGB (0-255) to CIE 1931 xy coordinates matching Hue color gamut.
    """
    # Gamma correction
    rf = r / 255.0
    gf = g / 255.0
    bf = b / 255.0

    r_linear = ((rf + 0.055) / 1.055) ** 2.4 if rf > 0.04045 else rf / 12.92
    g_linear = ((gf + 0.055) / 1.055) ** 2.4 if gf > 0.04045 else gf / 12.92
    b_linear = ((bf + 0.055) / 1.055) ** 2.4 if bf > 0.04045 else bf / 12.92

    # Wide RGB D65 conversion
    X = r_linear * 0.664511 + g_linear * 0.154324 + b_linear * 0.162028
    Y = r_linear * 0.283881 + g_linear * 0.668433 + b_linear * 0.047685
    Z = r_linear * 0.000088 + g_linear * 0.072310 + b_linear * 0.986039

    total = X + Y + Z
    if total == 0:
        return 0.3127, 0.3290  # Default white point D65

    x = X / total
    y = Y / total
    return round(x, 4), round(y, 4)


class HueClient:
    """
    Client for Philips Hue bridge controlling spot lights, TV light strips, and button events.
    """

    def __init__(
        self,
        base_url: str = "http://192.168.42.11",
        https_url: str = "https://192.168.42.11",
        user: str = "ckwwi95MBr7z3fnL-CwSbtfmlfOtjmLK9fGPPkCu",
        client_key: str = "63966C84DB0E23061742F382EEB72402",
        strip_tv1_id: int = 1,
        strip_tv2_id: int = 8,
        spot_ids: Optional[List[int]] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.https_url = https_url.rstrip("/")
        self.user = user
        self.client_key = client_key
        self.api_base = f"{self.base_url}/api/{self.user}"

        self.strip_tv1_id = strip_tv1_id
        self.strip_tv2_id = strip_tv2_id
        self.spot_ids = spot_ids or [2, 3, 4, 5, 6, 7]
        self.all_ids = [self.strip_tv1_id, self.strip_tv2_id] + self.spot_ids

        self._last_cmd_time = 0.0
        self._min_interval = 0.05  # Max ~20 cmd/s rate limit protection
        self._lock = threading.Lock()

    def _throttle(self):
        with self._lock:
            now = time.time()
            elapsed = now - self._last_cmd_time
            if elapsed < self._min_interval:
                time.sleep(self._min_interval - elapsed)
            self._last_cmd_time = time.time()

    def get_all_lights(self) -> dict:
        """Reads current state and metadata of all lights."""
        resp = requests.get(f"{self.api_base}/lights", timeout=4.0)
        resp.raise_for_status()
        return resp.json()

    def get_light(self, light_id: int) -> dict:
        """Reads status of a single light."""
        resp = requests.get(f"{self.api_base}/lights/{light_id}", timeout=3.0)
        resp.raise_for_status()
        return resp.json()

    def set_state(
        self,
        light_id: int,
        on: Optional[bool] = None,
        bri: Optional[int] = None,
        hue: Optional[int] = None,
        sat: Optional[int] = None,
        xy: Optional[Tuple[float, float]] = None,
        transitiontime: int = 4,
    ) -> dict:
        """
        Sends state update to a light.
        transitiontime: in tenths of a second (4 = 0.4s).
        """
        self._throttle()
        payload = {}
        if on is not None:
            payload["on"] = on
        if bri is not None:
            payload["bri"] = max(1, min(254, int(bri)))
        if hue is not None:
            payload["hue"] = max(0, min(65535, int(hue)))
        if sat is not None:
            payload["sat"] = max(0, min(254, int(sat)))
        if xy is not None:
            payload["xy"] = [xy[0], xy[1]]
        if transitiontime is not None:
            payload["transitiontime"] = transitiontime

        url = f"{self.api_base}/lights/{light_id}/state"
        resp = requests.put(url, json=payload, timeout=3.0)
        resp.raise_for_status()
        return resp.json()

    def set_rgb(
        self,
        light_id: int,
        r: int,
        g: int,
        b: int,
        brightness: int = 254,
        transitiontime: int = 4,
    ) -> dict:
        """Sets light color using RGB (0-255) and brightness (1-254)."""
        xy = rgb_to_xy(r, g, b)
        return self.set_state(
            light_id=light_id,
            on=True,
            bri=brightness,
            xy=xy,
            transitiontime=transitiontime,
        )

    def set_spots_rgb(
        self,
        r: int,
        g: int,
        b: int,
        brightness: int = 254,
        transitiontime: int = 4,
    ):
        """Sets all 6 room spot lights to the given RGB color."""
        for lid in self.spot_ids:
            self.set_rgb(lid, r, g, b, brightness=brightness, transitiontime=transitiontime)

    def set_tv_strips_rgb(
        self,
        strip1_rgb: Tuple[int, int, int],
        strip2_rgb: Optional[Tuple[int, int, int]] = None,
        brightness: int = 254,
        transitiontime: int = 4,
    ):
        """Sets TV 1 and TV 2 light strips."""
        s2 = strip2_rgb or strip1_rgb
        self.set_rgb(self.strip_tv1_id, strip1_rgb[0], strip1_rgb[1], strip1_rgb[2], brightness, transitiontime)
        self.set_rgb(self.strip_tv2_id, s2[0], s2[1], s2[2], brightness, transitiontime)

    def turn_off_all(self):
        """Turns off all spots and light strips."""
        for lid in self.all_ids:
            self.set_state(lid, on=False)

    def turn_on_all(self, brightness: int = 254):
        """Turns on all spots and light strips."""
        for lid in self.all_ids:
            self.set_state(lid, on=True, bri=brightness)

    def backup_state(self, filepath: Optional[str] = "lights_backup.json") -> dict:
        """
        Backs up current state of all lights.
        Crucial etiquette before your slot begins!
        """
        all_lights = self.get_all_lights()
        saved = {}
        for lid_str, data in all_lights.items():
            state = data.get("state", {})
            saved[lid_str] = {
                "on": state.get("on"),
                "bri": state.get("bri"),
                "hue": state.get("hue"),
                "sat": state.get("sat"),
                "xy": state.get("xy"),
                "ct": state.get("ct"),
                "colormode": state.get("colormode"),
            }
        if filepath:
            with open(filepath, "w") as f:
                json.dump(saved, f, indent=2)
        return saved

    def restore_state(self, filepath: Optional[str] = "lights_backup.json", state_dict: Optional[dict] = None):
        """
        Restores previously backed up lights state.
        Call this when your slot ends!
        """
        data = state_dict
        if not data and filepath:
            with open(filepath, "r") as f:
                data = json.load(f)

        if not data:
            raise ValueError("No backup data provided to restore")

        for lid_str, st in data.items():
            lid = int(lid_str)
            payload = {"on": st.get("on", True)}
            if st.get("colormode") == "xy" and st.get("xy"):
                payload["xy"] = st["xy"]
            elif st.get("colormode") == "ct" and st.get("ct"):
                payload["ct"] = st["ct"]
            elif st.get("hue") is not None:
                payload["hue"] = st.get("hue")
                payload["sat"] = st.get("sat")
            if st.get("bri") is not None:
                payload["bri"] = st.get("bri")

            self._throttle()
            requests.put(f"{self.api_base}/lights/{lid}/state", json=payload, timeout=3.0)

    def listen_buttons(self, on_button_event: Callable[[dict], None], stop_event: Optional[threading.Event] = None):
        """
        Connects to the Hue bridge Server-Sent Events (SSE) stream on /eventstream/clip/v2
        and listens for Hue button clicks.
        """
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

        req = urllib.request.Request(
            f"{self.https_url}/eventstream/clip/v2",
            headers={
                "hue-application-key": self.user,
                "Accept": "text/event-stream",
            },
        )

        with urllib.request.urlopen(req, context=ctx) as stream:
            while stop_event is None or not stop_event.is_set():
                line = stream.readline().decode("utf-8")
                if not line:
                    break
                if line.startswith("data:"):
                    raw = line[5:].strip()
                    if raw:
                        try:
                            events = json.loads(raw)
                            for ev in events:
                                for item in ev.get("data", []):
                                    if "button" in item or item.get("type") == "button":
                                        on_button_event(item)
                        except json.JSONDecodeError:
                            pass

    def __repr__(self) -> str:
        return f"<HueClient at {self.base_url}>"
