// The maps that can be built. Each is a rectangle of the city, the folder its OpenStreetMap
// downloads live in, and the file the app loads.
//
// `peakRate` is how many trips start per second at the height of rush hour. It is tuned by hand so
// that the network is busy but keeps flowing; a bigger map needs more.

export const MAPS = {
  // The city centre, about 5 x 5 km.
  central: {
    bbox: { s: 57.678, w: 11.925, n: 57.725, e: 12.01 },
    data: 'data',
    out: 'public/gbg.json',
    peakRate: 2.5,
  },
  // West to Älvsborgsbron and north past Tingstadstunneln, about 8 x 7 km: all three river crossings.
  west: {
    bbox: { s: 57.672, w: 11.875, n: 57.735, e: 12.01 },
    data: 'data/west',
    out: 'public/gbg-west.json',
    peakRate: 4,
  },
};

export function pick(name = 'central') {
  const map = MAPS[name];
  if (!map) throw new Error(`No map called "${name}". Choose one of: ${Object.keys(MAPS).join(', ')}`);
  return { name, ...map };
}
