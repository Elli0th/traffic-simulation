// Builds the city blocks out of small cubes. Returns voxel lists; main.js instances them.

import { CELL, ROAD } from './sim.js';

export const VOX = 0.5;

const FACADES = ['#6b7a8f', '#8d99ae', '#a68a64', '#7d8597', '#b08968', '#5c677d', '#9a8c98', '#c2b8a3'];
const PAVEMENT = '#3a3d44';
const GRASS = ['#3f7d3a', '#4a8f43', '#377034'];
const LEAVES = ['#2f9e44', '#37b24d', '#2b8a3e'];
const GLASS = '#1b2433';
const LIT = ['#ffd98a', '#ffe9b8', '#9fe8ff'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildCity(w, h, hospitalBlock, seed = 7) {
  const R = mulberry32(seed);
  const pick = (list) => list[Math.floor(R() * list.length)];
  const solid = [];
  const glow = [];
  const N = Math.round((CELL - ROAD) / VOX); // voxels along one side of a block

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const ox = i * CELL + ROAD / 2;
      const oz = j * CELL + ROAD / 2;
      const put = (list, vx, vy, vz, c) =>
        list.push({ x: ox + (vx + 0.5) * VOX, y: (vy + 0.5) * VOX, z: oz + (vz + 0.5) * VOX, c });

      const building = (x0, z0, wx, wz, hv, color, roofMark) => {
        for (let y = 1; y <= hv; y++) {
          for (let x = 0; x < wx; x++) {
            for (let z = 0; z < wz; z++) {
              const ex = x === 0 || x === wx - 1;
              const ez = z === 0 || z === wz - 1;
              const top = y === hv;
              if (!ex && !ez && !top) continue;
              if (top) {
                const mark = roofMark && roofMark(x, z);
                put(mark ? glow : solid, x0 + x, y, z0 + z, mark || color);
                continue;
              }
              const along = ex ? z : x;
              if (!(ex && ez) && y > 1 && y % 2 === 0 && along % 2 === 1) {
                if (R() < 0.4) put(glow, x0 + x, y, z0 + z, pick(LIT));
                else put(solid, x0 + x, y, z0 + z, GLASS);
                continue;
              }
              put(solid, x0 + x, y, z0 + z, color);
            }
          }
        }
      };

      const tree = (x, z) => {
        const trunk = 2 + Math.floor(R() * 2);
        for (let y = 1; y <= trunk; y++) put(solid, x, y, z, '#6b4f3a');
        const leaf = pick(LEAVES);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            for (let dy = 1; dy <= 3; dy++) {
              if (dy === 3 && (dx !== 0 || dz !== 0)) continue;
              if (dx !== 0 && dz !== 0 && R() < 0.4) continue;
              put(solid, x + dx, trunk + dy, z + dz, leaf);
            }
          }
        }
      };

      const park = (x0, z0, size) => {
        for (let x = 0; x < size; x++) {
          for (let z = 0; z < size; z++) put(solid, x0 + x, 1, z0 + z, pick(GRASS));
        }
        const trees = Math.max(1, Math.round((size * size) / 40));
        for (let t = 0; t < trees; t++) {
          tree(x0 + 1 + Math.floor(R() * (size - 2)), z0 + 1 + Math.floor(R() * (size - 2)));
        }
      };

      for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) put(solid, x, 0, z, PAVEMENT);

      if (i === hospitalBlock.i && j === hospitalBlock.j) {
        // White building with a red cross on the roof, readable from above.
        const size = N - 4;
        const mid = size / 2;
        building(2, 2, size, size, 8, '#e9ecef', (x, z) => {
          const ax = Math.abs(x + 0.5 - mid);
          const az = Math.abs(z + 0.5 - mid);
          return (ax < 1.5 && az < 4.5) || (az < 1.5 && ax < 4.5) ? '#ff3b30' : null;
        });
        continue;
      }

      const kind = R();
      if (kind < 0.15) {
        park(1, 1, N - 2);
      } else if (kind < 0.45) {
        const tall = R() < 0.3;
        building(2, 2, N - 4, N - 4, tall ? 16 + Math.floor(R() * 10) : 5 + Math.floor(R() * 8), pick(FACADES));
      } else {
        for (const x0 of [1, 9]) {
          for (const z0 of [1, 9]) {
            if (R() < 0.15) park(x0, z0, 6);
            else building(x0, z0, 6, 6, 3 + Math.floor(R() * (R() < 0.2 ? 18 : 9)), pick(FACADES));
          }
        }
      }
    }
  }
  return { solid, glow };
}
