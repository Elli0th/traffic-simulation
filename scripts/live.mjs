// Live traffic for the map, fetched by the dev server so the keys never reach a browser:
//
//   /live/status             which sources have a key
//   /live/roads?map=west     Trafikverket: what each road sensor measures, and current incidents
//   /live/vehicles?map=west  Västtrafik: where every tram, bus and ferry is
//
// The keys are free and go in .env.local (see .env.example). Without them the answers say so and
// the app carries on with simulated traffic.

import { MAPS } from './maps.mjs';

const ROADS_EVERY = 60; // seconds an answer is reused; the sensors report once a minute
const VEHICLES_EVERY = 4;
const STALE = 20 * 60 * 1000; // a sensor silent for this long is left out

export function live(env) {
  const tvKey = env.TRAFIKVERKET_KEY || '';
  // Västtrafik's portal shows an "authentication key", which is client id and secret already joined.
  const vtKey =
    env.VASTTRAFIK_KEY ||
    (env.VASTTRAFIK_CLIENT && env.VASTTRAFIK_SECRET
      ? Buffer.from(`${env.VASTTRAFIK_CLIENT}:${env.VASTTRAFIK_SECRET}`).toString('base64')
      : '');
  const TV = env.TRAFIKVERKET_URL || 'https://api.trafikinfo.trafikverket.se/v2/data.json';
  const VT = env.VASTTRAFIK_URL || 'https://ext-api.vasttrafik.se';

  const cache = new Map();
  function cached(key, seconds, load) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < seconds * 1000) return hit.value;
    const value = load();
    value.catch(() => {}); // each caller handles the failure; this only stops Node complaining
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  // ---------- Trafikverket ----------

  async function trafikverket(query) {
    const res = await fetch(TV, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: `<REQUEST><LOGIN authenticationkey="${tvKey}"/>${query}</REQUEST>`,
      signal: AbortSignal.timeout(15000),
    });
    // A refusal (a wrong key, say) may not come as JSON at all.
    const result = (await res.json().catch(() => null))?.RESPONSE?.RESULT?.[0];
    if (!result || result.ERROR) throw new Error(`Trafikverket: ${result?.ERROR?.MESSAGE || res.status}`);
    return result;
  }

  // "POINT (11.97 57.70)" or the first point of a line: [lon, lat].
  const lonLat = (wkt) => {
    const m = /(-?\d+\.?\d*)\s+(-?\d+\.?\d*)/.exec(wkt || '');
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const within = (bb, lon, lat) => lon >= bb.w && lon <= bb.e && lat >= bb.s && lat <= bb.n;

  // One entry per measuring site: every lane's count added up, and the speed averaged by vehicle.
  async function sensors(bb) {
    const result = await trafikverket(
      `<QUERY objecttype="TrafficFlow" schemaversion="1.5" limit="5000">
         <FILTER><WITHIN name="Geometry.WGS84" shape="box" value="${bb.w} ${bb.s}, ${bb.e} ${bb.n}"/></FILTER>
       </QUERY>`,
    );
    const sites = new Map();
    const now = Date.now();
    for (const f of result.TrafficFlow || []) {
      if (f.VehicleType && f.VehicleType !== 'anyVehicle') continue;
      const at = lonLat(f.Geometry?.WGS84);
      const time = Date.parse(f.MeasurementTime);
      if (!at || now - time > STALE) continue;
      let s = sites.get(f.SiteId);
      if (!s) sites.set(f.SiteId, (s = { id: f.SiteId, lon: at[0], lat: at[1], side: f.MeasurementSide || '', lanes: 0, flow: 0, sum: 0, time }));
      const flow = f.VehicleFlowRate || 0;
      s.lanes++;
      s.flow += flow;
      s.sum += flow * (f.AverageVehicleSpeed || 0);
      s.time = Math.max(s.time, time);
    }
    return [...sites.values()].map(({ sum, ...s }) => ({ ...s, kmh: s.flow ? Math.round(sum / s.flow) : 0 }));
  }

  let goodFilter = 0;
  // Accidents, roadworks and other reports that are in force now and lie on the map.
  async function incidents(bb) {
    const box = `value="${bb.w} ${bb.s}, ${bb.e} ${bb.n}"`;
    // The schema has changed its name for the position over the years, so try each; the last asks
    // for the whole county (14 is Västra Götaland) and leaves the sorting to the lines below.
    const filters = [
      `<WITHIN name="Deviation.Geometry.Point.WGS84" shape="box" ${box}/>`,
      `<WITHIN name="Deviation.Geometry.WGS84" shape="box" ${box}/>`,
      `<EQ name="Deviation.CountyNo" value="14"/>`,
    ];
    let result;
    let failure;
    // Begin with the one that worked last time, so a rejected filter is not asked again every minute.
    for (let k = 0; k < filters.length && !result; k++) {
      const which = (goodFilter + k) % filters.length;
      try {
        result = await trafikverket(`<QUERY objecttype="Situation" schemaversion="1.5" limit="2000"><FILTER>${filters[which]}</FILTER></QUERY>`);
        goodFilter = which;
      } catch (err) {
        failure = err;
      }
    }
    if (!result) throw failure;
    const now = Date.now();
    const seen = new Set();
    const list = [];
    for (const situation of result.Situation || []) {
      for (const d of situation.Deviation || []) {
        const g = d.Geometry || {};
        const at = lonLat(g.Point?.WGS84) || lonLat(g.WGS84) || lonLat(g.Line?.WGS84);
        if (!at || !within(bb, at[0], at[1]) || seen.has(d.Id)) continue;
        if (Date.parse(d.StartTime) > now || Date.parse(d.EndTime) < now) continue;
        seen.add(d.Id);
        list.push({
          id: d.Id,
          lon: at[0],
          lat: at[1],
          type: d.MessageType || '',
          what: d.MessageCode || d.Header || '',
          where: d.LocationDescriptor || d.RoadNumber || '',
          text: d.Message || '',
          lanes: d.NumberOfLanesRestricted || 0,
        });
      }
    }
    return list;
  }

  async function roads(bb) {
    const errors = [];
    const or = (err) => (errors.push(err.message), []);
    const [sites, reports] = await Promise.all([sensors(bb).catch(or), incidents(bb).catch(or)]);
    return { at: Date.now(), sites, incidents: reports, errors: [...new Set(errors)] };
  }

  // ---------- Västtrafik ----------

  let token = null;
  let signingIn = null; // one sign-in at a time, shared by every question waiting for it
  async function bearer() {
    if (token && Date.now() < token.until) return token.value;
    signingIn ||= authorise().finally(() => (signingIn = null));
    token = await signingIn;
    return token.value;
  }
  async function authorise() {
    const res = await fetch(`${VT}/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${vtKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Västtrafik would not sign in (${res.status})`);
    const json = await res.json();
    return { value: json.access_token, until: Date.now() + ((json.expires_in || 3600) - 60) * 1000 };
  }

  async function positions(bb, mode, again = true) {
    const key = await bearer();
    const q = new URLSearchParams({
      lowerLeftLat: bb.s, lowerLeftLong: bb.w, upperRightLat: bb.n, upperRightLong: bb.e, transportModes: mode, limit: 200,
    });
    const res = await fetch(`${VT}/pr/v4/positions?${q}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401 && again) {
      if (token?.value === key) token = null;
      return positions(bb, mode, false);
    }
    if (!res.ok) throw new Error(`Västtrafik: ${res.status}`);
    return (await res.json()).map((v) => ({
      id: v.detailsReference,
      mode: v.line?.transportMode || mode,
      line: v.line?.name || v.name || '',
      to: v.direction || '',
      lat: v.latitude,
      lon: v.longitude,
    }));
  }

  // One answer holds at most 200 vehicles, so the buses are asked for in two halves of the map.
  async function vehicles(bb) {
    const mid = (bb.w + bb.e) / 2;
    const answers = await Promise.allSettled([
      positions(bb, 'tram'),
      positions(bb, 'ferry'),
      positions({ ...bb, e: mid }, 'bus'),
      positions({ ...bb, w: mid }, 'bus'),
    ]);
    // One kind of vehicle failing does not take the others off the map; all of them failing does.
    const parts = answers.filter((a) => a.status === 'fulfilled').map((a) => a.value);
    const errors = [...new Set(answers.filter((a) => a.status === 'rejected').map((a) => a.reason.message))];
    if (!parts.length) throw new Error(errors.join('; '));
    const seen = new Set();
    const list = parts.flat().filter((v) => v.id && Number.isFinite(v.lat) && Number.isFinite(v.lon) && !seen.has(v.id) && seen.add(v.id));
    return { at: Date.now(), list, errors };
  }

  // ---------- the three addresses ----------

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const asked = url.searchParams.get('map');
    const name = Object.hasOwn(MAPS, asked) ? asked : 'central';
    const bb = MAPS[name].bbox;
    const reply = (code, body) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === '/status') return reply(200, { roads: Boolean(tvKey), vehicles: Boolean(vtKey) });
      if (url.pathname === '/roads') {
        if (!tvKey) return reply(503, { error: 'No TRAFIKVERKET_KEY in .env.local' });
        return reply(200, await cached(`roads:${name}`, ROADS_EVERY, () => roads(bb)));
      }
      if (url.pathname === '/vehicles') {
        if (!vtKey) return reply(503, { error: 'No VASTTRAFIK_KEY in .env.local' });
        return reply(200, await cached(`vehicles:${name}`, VEHICLES_EVERY, () => vehicles(bb)));
      }
      reply(404, { error: 'Not a live address' });
    } catch (err) {
      reply(502, { error: err.message });
    }
  }

  return {
    name: 'live-traffic',
    configureServer: (server) => void server.middlewares.use('/live', handle),
    configurePreviewServer: (server) => void server.middlewares.use('/live', handle),
  };
}
