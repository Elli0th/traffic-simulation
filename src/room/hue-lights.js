// Spatial Philips Hue lighting for Outbreak: Göteborg.
// Physical layout:
// - Left lights [1 (TV 1 Strip), 2, 3 (Left Spots)]: Starts RED (Spreader).
// - Middle lights [4, 5 (Center Spots)]: Starts WHITE (Contested neutral zone).
// - Right lights [6, 7 (Right Spots), 8 (TV 2 Strip)]: Starts GREEN (Curber/Government).
//
// As the game progresses, colors and intensity shift dynamically:
// - If the virus advances, RED intensifies and spreads into the middle spots (white -> amber -> red).
// - If the government contains it, GREEN intensifies and spreads into the middle spots (white -> cyan -> green).
// - Match conclusion: Entire room pulses victorious RED (Virus win) or GREEN (Government win).

const HUE_USER = 'ckwwi95MBr7z3fnL-CwSbtfmlfOtjmLK9fGPPkCu';

export const LIGHT_GROUPS = {
  left: [1, 2, 3],   // TV 1 strip + Left spots
  middle: [4, 5],     // Center spots
  right: [6, 7, 8],  // Right spots + TV 2 strip
};

export class VirusLighting {
  constructor(options = {}) {
    this.endpoint = options.endpoint || '/hue-api';
    this.directIp = options.directIp || '192.168.42.11';
    this.lastSent = 0;
    this.minIntervalMs = options.minIntervalMs || 1000;
    this.enabled = options.enabled ?? true;
    this.lastState = null;
  }

  // Calculates spatial lighting configuration
  computeLighting(game) {
    if (!game) return null;
    const c = game.counts();
    const total = Math.max(1, game.total);
    const activeShare = (c.e + c.i) / total;
    const everShare = c.ever / total;

    // Infection intensity and containment progress during the timed round.
    const virusProgress = Math.min(1.0, everShare);
    const timeAdv = Math.min(1.0, (game.time || 0) / (180 * 30));
    const curberProgress = timeAdv * (1.0 - activeShare * 2.0);

    // Balance metric: negative = curber, positive = virus
    const balance = Math.max(-1.0, Math.min(1.0, (virusProgress * 1.3) - (curberProgress * 0.9)));

    // Active action flash states
    const hasParty = Boolean(game.parties?.some((p) => p.until > game.time));
    const hasLockdown = Boolean(game.lockdowns?.some((z) => (z.start || 0) <= game.time && z.until > game.time));

    // 1. LEFT LIGHTS [1, 2, 3]: Always RED, intensity scales with virus progress
    const leftBri = hasParty ? 254 : Math.round(130 + 124 * Math.max(0, balance + 0.4));
    const leftState = {
      on: true,
      hue: hasParty ? 65000 : 0, // Pure red
      sat: 254,
      bri: Math.min(254, leftBri),
      transitiontime: hasParty ? 2 : 6,
    };

    // 2. RIGHT LIGHTS [6, 7, 8]: Always GREEN, intensity scales with government containment
    let rightBri = hasLockdown ? 254 : Math.round(130 + 124 * Math.max(0, -balance + 0.4));
    let rightHue = 25500; // Emerald green
    let rightSat = 254;

    // If virus is overwhelming (> 65% balance), right lights dim and flicker amber
    if (balance > 0.65) {
      rightHue = 10000; // Amber warning
      rightBri = Math.round(70 + 40 * (1 - balance));
    }

    const rightState = {
      on: true,
      hue: rightHue,
      sat: rightSat,
      bri: Math.min(254, rightBri),
      transitiontime: hasLockdown ? 2 : 6,
    };

    // 3. MIDDLE LIGHTS [4, 5]: Start WHITE, spreads RED (if virus ahead) or GREEN (if curber ahead)
    let midState = { on: true, transitiontime: 8 };

    if (Math.abs(balance) < 0.15) {
      // Neutral center: Daylight White
      midState.ct = 370;
      midState.sat = 0;
      midState.bri = 130;
    } else if (balance > 0.15) {
      // Virus pushing into middle: White -> Warm Amber -> Crimson Red
      const virusSpread = (balance - 0.15) / 0.85; // 0.0 to 1.0
      const midHue = Math.round(14000 * (1 - virusSpread)); // 14000 (amber) -> 0 (red)
      const midBri = Math.round(130 + 124 * virusSpread);
      const midSat = Math.round(140 + 114 * virusSpread);
      midState.hue = midHue;
      midState.sat = midSat;
      midState.bri = Math.min(254, midBri);
    } else {
      // Government pushing into middle: White -> Cool Cyan -> Emerald Green
      const curberSpread = (-balance - 0.15) / 0.85; // 0.0 to 1.0
      const midHue = Math.round(38000 * (1 - curberSpread) + 25500 * curberSpread);
      const midBri = Math.round(130 + 124 * curberSpread);
      const midSat = Math.round(140 + 114 * curberSpread);
      midState.hue = midHue;
      midState.sat = midSat;
      midState.bri = Math.min(254, midBri);
    }

    // A neutral end-of-round signal, independent of infection levels.
    if (game.phase === 'over') {
      const neutral = { on: true, ct: 350, sat: 0, bri: 140, transitiontime: 15 };
      return { balance, left: neutral, middle: neutral, right: neutral };
    }

    return { balance, left: leftState, middle: midState, right: rightState };
  }

  // Sends state to Hue bridge with rate-limiting
  async update(game, force = false) {
    if (!this.enabled || !game) return;
    const now = Date.now();
    if (!force && now - this.lastSent < this.minIntervalMs) return;

    const target = this.computeLighting(game);
    if (!target) return;
    this.lastSent = now;
    this.lastState = target;

    this.dispatchState(target).catch(() => {});
  }

  async dispatchState(target) {
    // 1. Left lights (1, 2, 3)
    for (const id of LIGHT_GROUPS.left) {
      await this.setLight(id, target.left);
    }
    // 2. Middle lights (4, 5)
    for (const id of LIGHT_GROUPS.middle) {
      await this.setLight(id, target.middle);
    }
    // 3. Right lights (6, 7, 8)
    for (const id of LIGHT_GROUPS.right) {
      await this.setLight(id, target.right);
    }
  }

  async setLight(id, body) {
    const json = JSON.stringify(body);
    const urls = [
      `${this.endpoint}/api/${HUE_USER}/lights/${id}/state`,
      `http://${this.directIp}/api/${HUE_USER}/lights/${id}/state`,
    ];

    for (const url of urls) {
      try {
        const resp = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: json,
        });
        if (resp.ok) return;
      } catch {}
    }
  }

  async restoreNeutral() {
    const neutral = { on: true, bri: 140, ct: 350, transitiontime: 10 };
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) {
      await this.setLight(id, neutral).catch(() => {});
    }
  }
}
