// Downloads the OpenStreetMap data for one map into its data folder.
//
//   node scripts/fetch-map.mjs west
//
// The three queries in data/query*.txt are written for the central map; the rectangle in them is
// swapped for the chosen map's. Then run: node scripts/build-map.mjs west

import fs from 'node:fs';
import { pick } from './maps.mjs';

const map = pick(process.argv[2]);
const { s, w, n, e } = map.bbox;
const root = new URL('../', import.meta.url);
const FILES = { 'query.txt': 'raw.json', 'query-extra.txt': 'extra.json', 'query-rules.txt': 'rules.json' };
const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

fs.mkdirSync(new URL(`${map.data}/`, root), { recursive: true });
for (const [queryFile, outFile] of Object.entries(FILES)) {
  const out = new URL(`${map.data}/${outFile}`, root);
  if (fs.existsSync(out) && !process.argv.includes('--again')) {
    console.log(`${outFile}: already downloaded (pass --again to refresh)`);
    continue;
  }
  let query = fs.readFileSync(new URL(`data/${queryFile}`, root), 'utf8');
  query = query.replace(/\[bbox:[^\]]+\]/, `[bbox:${s},${w},${n},${e}]`).replace(/\[timeout:\d+\]/, '[timeout:300]');
  // The sea is mapped as a coastline rather than as an area of water.
  if (queryFile === 'query.txt') query = query.replace('way[natural=water];', 'way[natural=water];\n  way[natural=coastline];');

  let done = false;
  for (let attempt = 0; attempt < 6 && !done; attempt++) {
    const server = SERVERS[attempt % SERVERS.length];
    try {
      const response = await fetch(server, {
        method: 'POST',
        headers: { 'User-Agent': 'tangible-table-hackathon/0.1', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      });
      const text = await response.text();
      if (!response.ok || !text.startsWith('{')) throw new Error(`answered ${response.status}`);
      JSON.parse(text);
      fs.writeFileSync(out, text);
      console.log(`${outFile}: ${(text.length / 1e6).toFixed(1)} MB from ${new URL(server).host}`);
      done = true;
    } catch (error) {
      console.log(`${outFile}: ${new URL(server).host} ${error.message}; trying again in 20 s`);
      await new Promise((resolve) => setTimeout(resolve, 20000));
    }
  }
  if (!done) {
    console.error(`${outFile}: could not be downloaded`);
    process.exit(1);
  }
}
