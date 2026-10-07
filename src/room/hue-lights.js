// Controls Philips Hue room lighting to react dynamically to the virus outbreak.
// As infection spreads, ceiling spots ramp from calm clinic cyan to glaring emergency crimson,
// while TV backstrips reflect the asymmetric factions (TV 1 = Spreader red/orange, TV 2 = Curber cyan/blue).

const HUE_USER = 'ckwwi95MBr7z3fnL-CwSbtfmlfOtjmLK9fGPPkCu';
const SPOTS = [2, 3, 4, 5, 6, 7];
const STRIP_SPREADER = 1; // TV 1 backstrip
const STRIP_CURBER = 8;   // TV 2 backstrip

export class VirusLighting {
  constructor(options = {}) {
    this.endpoint = options.endpoint || '/hue-api';
    this.directIp = options.directIp || '192.168.42.11';
    this.lastSent = 0;
    this.minIntervalMs = options.minIntervalMs || 1000;
    this.enabled = options.enabled ?? true;
    this.lastState = null;
  }

  // Calculates lighting parameters from the current outbreak state.
  computeLighting(game) {
    if (!game) return null;
    const c = game.counts();
    const total = Math.max(1, game.total);
    const activeShare = (c.e + c.i) / total;
    const everShare = c.ever / total;

    // Threat level from 0.0 (calm baseline) to 1.0 (runaway disaster)
    const threat = Math.min(1.0, activeShare * 3.5 + everShare * 1.2);

    // Ceiling spot intensity:
    // Low: calm cyan (hue ~40000, bri ~70, sat ~120)
    // Mid: warning amber (hue ~12000, bri ~150, sat ~200)
    // High: deep crimson red (hue ~0, bri ~254, sat ~254)
    let spotHue;
    if (threat < 0.25) {
      const t = threat / 0.25;
      spotHue = Math.round(40000 * (1 - t) + 14000 * t);
    } else if (threat < 0.6) {
      const t = (threat - 0.25) / 0.35;
      spotHue = Math.round(14000 * (1 - t) + 5500 * t);
    } else {
      const t = (threat - 0.6) / 0.4;
      spotHue = Math.round(5500 * (1 - t));
    }

    const spotBri = Math.round(70 + 184 * threat);
    const spotSat = Math.round(120 + 134 * threat);

    // Spreader TV strip (Light 1): Red/Orange, pulses during active parties
    const hasParty = Boolean(game.parties?.some((p) => p.until > game.time));
    const spreaderBri = hasParty ? 254 : Math.round(120 + 130 * threat);
    const spreaderHue = hasParty ? 65000 : Math.round(2000 + 4000 * (1 - threat));

    // Curber TV strip (Light 8): Cyan/Teal defense, intensifies with lockdowns & vaccination
    const hasLockdown = Boolean(game.lockdowns?.some((z) => (z.start || 0) <= game.time && z.until > game.time));
    const vaccineShare = c.r / total;
    const curberBri = hasLockdown ? 254 : Math.round(100 + 140 * Math.min(1.0, vaccineShare * 2 + (hasLockdown ? 0.4 : 0)));
    const curberHue = hasLockdown ? 38000 : 42000;

    return {
      threat,
      spots: { on: true, bri: spotBri, hue: spotHue, sat: spotSat, transitiontime: 8 },
      spreaderStrip: { on: true, bri: spreaderBri, hue: spreaderHue, sat: 254, transitiontime: hasParty ? 2 : 8 },
      curberStrip: { on: true, bri: curberBri, hue: curberHue, sat: 220, transitiontime: hasLockdown ? 2 : 8 },
    };
  }

  // Sends state to Hue bridge with rate-limiting.
  async update(game, force = false) {
    if (!this.enabled || !game) return;
    const now = Date.now();
    if (!force && now - this.lastSent < this.minIntervalMs) return;

    const target = this.computeLighting(game);
    if (!target) return;
    this.lastSent = now;
    this.lastState = target;

    // Send asynchronously in background without blocking simulation
    this.dispatchState(target).catch(() => {});
  }

  async dispatchState(target) {
    // 1. Update ceiling spots
    for (const id of SPOTS) {
      await this.setLight(id, target.spots);
    }
    // 2. Update TV backstrips
    await this.setLight(STRIP_SPREADER, target.spreaderStrip);
    await this.setLight(STRIP_CURBER, target.curberStrip);
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
      } catch {
        // Fallback to next URL
      }
    }
  }

  async restoreNeutral() {
    const neutral = { on: true, bri: 140, ct: 350, transitiontime: 10 };
    for (const id of [...SPOTS, STRIP_SPREADER, STRIP_CURBER]) {
      await this.setLight(id, neutral).catch(() => {});
    }
  }
}
