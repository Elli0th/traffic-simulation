// Fast instant disconnect and reset script for the Outbreak room installation.
// Executes all network calls in parallel with a 1.5-second hard timeout.

const HUE_IP = '192.168.42.11';
const HUE_USER = 'ckwwi95MBr7z3fnL-CwSbtfmlfOtjmLK9fGPPkCu';
const DISPLAYS = [
  { name: 'Projector', url: 'http://192.168.42.21/show' },
  { name: 'TV 1 (Spreader)', url: 'http://192.168.42.22/show' },
  { name: 'TV 2 (Curber)', url: 'http://192.168.42.23/show' },
];

async function postWithTimeout(url, body, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await res.json();
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function putWithTimeout(url, body, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await res.json();
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  const start = performance.now();
  console.log('⚡ Disconnecting room displays and resetting lights...');

  // 1. Reset all 3 displays in parallel
  const displayTasks = DISPLAYS.map(async (d) => {
    const body = d.name.includes('Projector') ? { blank: true } : { idle: true };
    const res = await postWithTimeout(d.url, body);
    return `${d.name}: ${res.ok ? 'done' : res.error || 'done'}`;
  });

  // 2. Reset all 8 Hue lights in parallel
  const neutral = { on: true, bri: 140, ct: 350, transitiontime: 5 };
  const lightTasks = [1, 2, 3, 4, 5, 6, 7, 8].map(async (id) => {
    return putWithTimeout(`http://${HUE_IP}/api/${HUE_USER}/lights/${id}/state`, neutral);
  });

  const [displayRes, lightRes] = await Promise.all([
    Promise.all(displayTasks),
    Promise.all(lightTasks),
  ]);

  displayRes.forEach((msg) => console.log(`  ✓ ${msg}`));
  const okLights = lightRes.filter((r) => Array.isArray(r) && r[0]?.success).length;
  console.log(`  ✓ Hue lights: ${okLights}/8 restored to neutral white`);
  const elapsed = Math.round(performance.now() - start);
  console.log(`✨ All reset in ${elapsed}ms.`);
}

run();
