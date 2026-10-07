# Tangible Table · Göteborg

> **Looking for the latest version?** The branch that got furthest is
> [`game-room-api`](https://github.com/Elli0th/traffic-simulation/tree/game-room-api): the outbreak
> game, the connection to the room and the streaming to its displays, with a guide to every branch in
> its README. This branch, `game-room-api-next`, is a staging copy that was used to try a merge. It is kept for reference, and the
> text below describes it as it was.


A live traffic simulation of Gothenburg built for a projected table: put an object on a street and
the street closes, and the city reacts around it. It comes with two maps, the city centre and a
larger one that reaches Älvsborgsbron.

```bash
npm install
npm run dev
```

Open http://localhost:5173 for the city centre, or http://localhost:5173/?map=west for the larger
map. The first version, a small invented grid city, is still at `/grid.html`.

## Two modes

The switch at the bottom left of the table window (top right during the game), or `M`, changes between them. The screens follow
the table.

| Mode | Address | What it is |
| --- | --- | --- |
| Traffic demo | `/` | The city and its traffic: put an object on a street and it closes |
| Outbreak game | `/?game=table` | The two-player game on top of the same traffic, with every way of playing switched on: pieces and hands on the table, and the mouse and keyboard |

`/?game` is the game with the mouse and keyboard only.

## Controls

| Input | Effect |
| --- | --- |
| Click | Place an object, or remove the one under the cursor |
| Drag | Move an object |
| Scroll | Zoom, or resize the object under the cursor |
| Right-drag, arrow keys | Pan |
| `0` | Whole city |
| `V` | Switch between the table view (top-down) and the 3D screen view. `?view=screen` starts in 3D |
| `1` `2` `3` `4` | Speed: 1×, 3×, 10×, 30× |
| Space | Pause |
| `T` | Jump one hour ahead |
| `+` `-` | More or less traffic |
| `H` `C` `F` | Hide the panel, clear all objects, fullscreen |
| `L` | Live traffic on or off (needs keys, see Live traffic) |

## Outbreak game (two players)

Open http://localhost:5173/?game and choose **1 player** or **2 players** on the start menu (or skip the menu with `?game&players=1` or `?game&players=2`). In the 1 player game you are the Spreader and the computer plays the Curber (`src/curber-ai.js`). It uses the same actions, costs and cooldowns as a person, and is lenient on purpose: it ignores the outbreak until about 1% of the city has caught it, waits a week of game days before its first move, then acts every 4 to 8 days and aims its lockdowns imperfectly. The 1 player game is one full screen with a log on the right that says what the computer did and when, including when it first noticed the outbreak, and its lockdown circles are drawn on your map.

In the 2 player game: Two side-by-side cameras show the same city and outbreak.
Spreader is on the left, Curber on the right. Each has independent + / - / Whole map buttons,
scroll zoom and right-drag pan. Actions target only their owner's map; selecting an action on one
side never arms the other side. The top bar spans both sides and shows current infected (exposed
plus infectious) and non-infected (susceptible plus recovered) totals. All people use red/green dots,
including people currently indoors. Isolation and vaccination status are not revealed by dot colour.
Only the Spreader sees party/worker pins; only the Curber sees lockdown pins and zones. No opponent
action announcements are shown. Points, action buttons and cooldowns sit in covered panels; click
Show / hide to open your panel. It stays open for rapid actions; only one panel opens at a time.
A shared screen still lets someone physically look across; this is visual separation, not secure device privacy.
Click a busy street to place four initial exposed people for free.
Hover before placement to see a dashed target area and nearest named landmark. Placed actions get
numbered pins and colour-coded areas: dashed for pending, solid for active, faded for finished.
My actions & effects shows countdowns, party infection counts and citywide vaccination/isolation
progress. Click a pin or a local action row to zoom to its location. Repeat here reuses the last map
location, respecting its action's cost and cooldown. Immediate click confirmation is distinct from
the simulated delay before an intervention begins.

Spreader can Rally supporters; Curber can Mobilise volunteers. Tap rapidly or hold to earn 0.3 points
per accepted tap, capped at one reward every 3 simulated seconds per player (about 10 taps/sec at
30x). The effort bar fills over 20 taps. Rewards stop when paused or the round ends, and never bypass
an action's cooldown. Both players use the same reward rules.

Outbreak mode uses a pedestrian/crossing-signal loop with quarter-second movement steps. It omits
road-vehicle and transit simulation, decorative trees and expensive traffic metrics; the normal
traffic simulation remains at `/`. Locked-down and isolated people stop moving. Rendering uses
one pixel per CSS pixel and larger infection dots for clarity. Each player's static city image is cached
until zoom, pan or resize changes their camera; ordinary frames only redraw moving people. Compare the loops with
`node scripts/benchmark-game.mjs`; focused action tests use `node scripts/test-virus.mjs --actions-only`.

The round runs three real minutes; at 30x that is 90 simulated minutes, representing 60 game days. All action timings below
use simulated time. This is an accelerated fictional game model, not a prediction for any disease.

Scale and realism: a round stands for 60 days (30× speed). Each simulated person stands for about 290 of Göteborg's 600,000 people, and the virus follows the original COVID-19 strain: 3 days until infectious, 8 days infectious, R0 of about 2.5, 5% needing a hospital bed, 0.7% dying. Counts are shown in real people. People live around homes and workplaces, so dense districts are crowded and risk there is scaled by how built-up the area is. Trams and buses carry the virus: people waiting at a stop mix with the passengers, so an infectious rider takes it to the next stop (infected vehicles turn red).

**No winner.** A round is a plain three minutes (60 game days): it does not end early when the virus
spreads far or dies out, and ends with a summary of how far it went. The model retains the updated
branch's car and transit infection hooks for full simulation runs; the lightweight playable loop
omits vehicle movement as described above.

| Player / key | Action | Delay | Effect / duration |
| --- | --- | --- | --- |
| Spreader Q + click | Start a party (10 pax) | Immediate | Ten nearest people within 300m; extra group contacts for 10m |
| Spreader W | Antimask conspiracy | 5m | Contact transmission x1.4 for 30m |
| Spreader E | Antivaxx conspiracy | 5m | Vaccine acceptance falls from 85% to 25% for 40m |
| Spreader R + click | Send someone sick to work | Immediate | Nearest infectious person within 300m stays outside and evades isolation for 15m; lockdown still applies |
| Curber I + click | Lockdown | 1m | 220m zone keeps 90% of people home for 30m and cancels party contacts there |
| Curber O | Free vaccines | 2m | Citywide rollout for 30m; each unvaccinated person has an 85% / 600 per-second uptake chance (25% / 600 during antivaxx) |
| Curber P | Social distancing | 1m | Ordinary transmission x0.55 and party transmission x0.45 for 30m |
| Curber L | New hospitals | 10m | Permanently increases case detection and isolation |
| Curber K | New vaccine | 20m | Permanent improvement from 65% to 90% susceptibility reduction for vaccinated people |

Vaccination protects after another 5m and does not cure existing infections. Vaccinated people can
still catch and transmit infection. A party adds a hazard of 0.004 per infectious attendee per second
(about 21% risk over one minute with one infectious attendee, before protection/distancing).
Ordinary close contact uses the updated branch's density-weighted transmission model. These accelerated
rates depend on the actual crowd, movement and interventions; they are not fixed citywide infection rates.
Incubation averages 3 game days; infectious duration averages 8 game days, both with +/-30% variation.
Recovered people are immune for the round. Hospital demand and deaths are population estimates.
Action costs, delays, durations and cooldowns are in `ACTIONS` in `src/virus.js`.

**On the table, with the room's sensors.** Open the table with `/?game=table` and the screens with
`/?game&view=screen`. The rules, the two maps and the panels are the same; hands and objects press
the buttons and click the maps. The players sit side by side, the Spreader at the left half.

| What the sensors see | What it does |
| --- | --- |
| A hand or object held on a button for a second | Presses it: Show / hide, an action, + and -, Play again |
| An object put down on your own map | Plays there. The Spreader's first one places patient zero. After that it is the action chosen on the panel, or a party (Spreader) or a lockdown (Curber) if none is chosen |

Whose piece it is follows from which half of the table it stands on. A piece counts once it has
stood still for a second, so an arm reaching over the map does nothing; one that cannot be played
yet (points, cooldown) is played as soon as it can be; lift it and put it down to play again.
Dragging and zooming the map with the lidar is switched off. The screens show a dashboard instead of
the map: the clock, the shared totals, how close each side is to winning, the curve of cases and a
grid of where the virus is, not either player's private panel. To rehearse without the room, use the camera
page's pretend table.

### Reactive Philips Hue Lighting & Asymmetric TV Dashboards

When running `?game`, the installation connects to the room's physical displays and Philips Hue bridge:

1. **Reactive Philips Hue Ceiling Spots & TV Strips** (`src/room/hue-lights.js`):
   - **Ceiling Spots (2–7)**: As the virus spreads, lights dynamically transition from calm clinic cyan (`hue ~ 40000`, brightness 70) through cautionary amber into intense, glaring emergency crimson (`hue ~ 0`, brightness 254).
   - **TV 1 Strip (Light 1 - Spreader)**: Red/Orange glow that pulses to maximum brightness (254) whenever a super-spreader party or offensive conspiracy is launched.
   - **TV 2 Strip (Light 8 - Curber)**: Protective cyan/blue shield that brightens as lockdowns and vaccination coverage expand.

2. **Asymmetric Tactical Dashboards on Both Televisions** (`/dashboard.html`):
   - **Television 1 (Spreader Strategic Command)**:
     - **Recent Actions Feed**: Displays your last offensive strike with active countdown timer alongside enemy countermeasures detected.
     - **Actionable Intel**: Ranks top 3 high-density unprotected districts (e.g. Nordstaden, Inom Vallgraven, Haga) to strike next.
     - **Transit Vectors**: Tracks trams carrying infected passengers spreading the virus across the city.
     - **Action Deck**: Real-time points, cooldown counters, and tactical recommendations.
   - **Television 2 (Curber Public Health Defense)**:
     - **Recent Actions Feed**: Displays your last quarantine/vaccine deployment alongside detected outbreak breaches.
     - **Actionable Intel**: Pinpoints top active infection hotspots requiring immediate lockdown or contact tracing.
     - **Healthcare Stress**: Tracks hospital bed capacity and ICU saturation level.
     - **Vaccination Campaign**: Population immunity progress and disinformation resistance tracking.
     - **Intervention Deck**: Real-time points, cooldown counters, and defensive recommendations.

3. **Room Automation Command** (`scripts/room-virus.mjs`):
   ```bash
   # Point Table to ?game, TV 1 to Spreader Dashboard, TV 2 to Curber Dashboard
   node scripts/room-virus.mjs show

   # Reset all displays to idle and restore Hue lights to neutral ambient
   node scripts/room-virus.mjs idle
   ```

The panel at the top right of the table window turns the map into a what-if tool. Choose a tool, then
click a street (or, with the depth camera running, put an object on it):

| Tool | What it does |
| --- | --- |
| Close (object) | The default: an object closes the street under it |
| One lane fewer / more | Changes the street's lanes each way. Amber means narrowed, green widened |
| Roadworks | Closes the street between the two hours given. Purple until it is in force |
| Draw a new road | Click along the route; double-click or Enter to finish. Its ends join the nearest junctions |
| Undo last | Removes the latest change |

**Compare** runs the coming two hours, or the whole day, twice in the background, with and without
the plan, and shows average speed, trip time, hours spent driving, trips completed and the ambulance
time side by side. A two-hour comparison takes from under a minute to a few minutes: a plan that
causes heavy jams takes longer to compute. It covers road vehicles only.

## What is simulated

- **Streets**: the real network from OpenStreetMap, with speed limits, lane counts, one-way streets and
  mapped turn bans.
- **Driving**: every vehicle follows the Intelligent Driver Model, so it accelerates, keeps a gap and
  brakes for what is ahead. Vehicles slow for bends and turns, change lanes, and never overlap.
- **Junctions**: signalled junctions (179 in the centre, 224 on the west map) with traffic-actuated lights, give-way and roundabout rules by
  road class and signs, left turns that wait for a gap in oncoming traffic.
- **Demand**: trips between homes, workplaces and the edges of the map, weighted by floor area and road
  class, following a daily profile with morning and evening rush hours. Drivers pick routes by current
  travel times and switch when traffic ahead makes another way clearly quicker.
- **Public transport**: trams on their real lines with stops and dwell times, buses on their real routes (141 in the centre)
  stopping at mapped bus stops, ferries on the river.
- **People**: pedestrians and cyclists on the mapped paths. They wait for the green man at signals, and
  drivers stop for them at zebra crossings.
- **Day and night**: sunrise and sunset for early October, with lit windows and headlights after dark.

## Live traffic

With two free keys the map shows what Gothenburg is doing right now. Copy `.env.example` to
`.env.local`, fill in the keys and restart `npm run dev`. The panel's "Live traffic" row then counts
what is coming in, the clock follows the real time and the speed starts at 1×. `L` switches live
traffic off and on; `?live=0` starts without it. With no keys nothing changes.

| Source | What it gives | What the map does with it |
| --- | --- | --- |
| Trafikverket, road sensors | Speed and vehicles an hour at measuring sites on the big roads, every minute | Drivers within 400 m of a site go no faster than traffic there really is. The number of trips starting follows how full the measured lanes are, in place of the daily profile |
| Trafikverket, incidents | Accidents, roadworks and other reports | A pulsing ring on the map: red for an accident, amber otherwise. An accident also takes a lane from its street and slows it to 30 km/h |
| Västtrafik, vehicle positions | Where every tram, bus and ferry is, every five seconds | The real trams run on their tracks and road traffic gives way to them. The real buses and river ferries replace the simulated ones |

The cars are still simulated, since nobody publishes where every car is; live traffic sets how many
there are and how fast the measured roads move. The real buses are drawn where they are and the
simulated cars do not see them. Compare still uses the daily profile for both of its runs. How full
a lane counts as rush hour is one assumed number, `LANE_PEAK` in `src/live.js`.

The dev server fetches the data (`scripts/live.mjs`), so the keys stay on the laptop and every
window shares one answer. A built copy of the site has no server and runs simulated.

## In the room

Everything talks through the dev server on your laptop, so start it first and note the `Network`
address it prints (for example `http://192.168.0.117:5173`). Other machines use that address.

| Window | Address | Where |
| --- | --- | --- |
| Table | `/` | The projector. Fullscreen (`F`), panel hidden (`H`). Only one of these. |
| Screens | `/?view=screen` | The TVs. They follow the table: same objects, clock and area, in 3D. During the game they show its dashboard instead. |
| Camera | `/camera.html` | Your laptop. Keep this window visible; browsers slow down hidden pages. |
| Lidar | `/lidar.html` | Your laptop, also visible. Turns hands over the table into map movements. |

### Setting up, in order

For the outbreak game, one command does the start of a slot: `npm run room boot`. It checks that the
laptop is on the room wifi, that the dev server and the lidar answer, opens the lidar page, puts the
game on the projector and its dashboard on the TVs, and stops with what to do if any of that is not
ready. The lidar page remembers its calibration and the empty table, so it only asks for them again
if the table, lidar or projector has moved. The steps below are what it does, by hand.

1. **Get the pictures onto the displays.** Join the room wifi (`AID-Hackathon-5G`) and, during your
   slot, run
   ```bash
   npm run room show
   ```
   It asks the projector to open the table page and both TVs to open the 3D view, from this laptop's
   address on the room network. `npm run room show draw` shows the light painting, `npm run room show
   map=west` the larger map, `npm run room status` what each display is showing, and `npm run room
   idle` hands them back. `ROOM=sim` in front talks to the virtual room (Docker) instead.

   If a display's own browser is too slow for the city, render it on the laptop: open the table with
   `/?push=ws://pi-projector.local/frames` (TVs: `/?view=screen&push=ws://pi-tv-1.local/frames`) and
   keep that window visible. Each frame goes to the display as a JPEG; `&fps=20` sets the rate. A
   window about 1280 × 800 keeps it within what the wifi carries.
   The room has a colour webcam, not a depth camera, so steps 2 to 5 below (the camera page) only
   apply with a depth camera of your own. In the room, objects come from the lidar: see Hands below.
2. **Connect the camera.** On the camera page choose the source, enter the address of the depth frames
   and press Connect. You should see the table from above in grey.
3. **Capture the empty table.** Clear the table and press the button. Redo this if the table or
   camera is moved.
4. **Calibrate.** Press Calibrate. The table shows a white circle; put an object on it and take your
   hand away. It moves on by itself after about a second. Repeat for all four. If the camera cannot
   pick the object out, click where it is in the camera picture instead.
5. **Check.** Put an object on a street. A red ring should appear around it on the table and the
   street should close. If the ring is offset, calibrate again.

Lock the zoom before the demo: object positions are fractions of the projected picture, so zooming
changes which streets an object covers. Around 1 km across works well for cups.

### Hands: moving the map with the lidar

The lidar on the table's back edge sweeps about 3 cm above the surface, so it sees hands reaching
over and anything standing on the table. On the lidar page choose "WebSocket stream" (the address is
already `ws://pi-lidar.local/scan`; `ws://localhost:8024/scan` in the virtual room), connect, capture
the empty table and calibrate by holding a finger on each glowing circle. Then:

- **One hand moving** drags the map.
- **Two hands moving apart or together** zoom in or out.
- **Anything that stays still for a second** is treated as an object: it does not move the map, and
  it closes the street under it (untick "Things that stand still close streets" to turn that off).

The page reads the room's sweeps, `{ t, points: [{ angle, distance, quality }] }`, and also
`{ angle_min, angle_increment, ranges }` or a bare list of `{ angle, distance }`; `decodeScan` in
`src/room/scan.js` is where that happens. Wherever the lidar sits and whichever way its 0° points,
calibration takes care of it. If it is moved, capture the empty table and calibrate again.

### If the camera's API is not what the page expects

- **The browser blocks the request (CORS).** Start the server with the room's address and use
  `/room-api/...` on the camera page:
  ```bash
  ROOM_API=http://address-of-the-room npm run dev
  ```
- **The format is different.** `decode` in `src/room/sources.js` is the one place that turns a
  response into `{ width, height, data }`. It already handles raw 16-bit millimetres, raw 32-bit
  metres, JSON and pictures.
- **The feed is a picture where nearer is brighter.** Untick "Smaller numbers mean nearer" and lower
  "Lowest object", since heights are then in shades rather than millimetres.
- **Objects flicker or small things are missed.** Adjust the three sliders under Table.

### Rehearsing without the room

The camera page starts with a simulated camera. Click on the "pretend table" to place objects, and
run the calibration with "Put a cup on the marker". The same pipeline is checked by

```bash
npm test
```

### Light painting

`/draw.html` is a second thing to put on the projector, in place of the city. A hand moving over the
table leaves a glowing ribbon that sways and fades after 45 seconds (`?life=20` changes that).
Something left standing still stops painting and throws sparks. The camera and lidar pages drive it
exactly as they drive the city, calibration included, so switching between the two needs no new
setup. `/draw.html?view=screen` on the TVs shows what the table paints. The mouse or a touch screen
paints too, `C` clears and `F` is fullscreen.

### Other hooks

- **Lights, sound, narrator.** The table page fires a `table-metrics` event four times a second.
  `event.detail` holds the clock, congestion, vehicle count, average speed, closed streets, diverted
  vehicles, detour minutes and the ambulance delay.
- **Objects from your own code.** `window.table.setBlobs([{ x, y, r }])` on the table page, with `x`
  and `y` from 0 to 1 across the picture and `r` as a fraction of its width.
- **Scripted camera moves.** `window.table.look(x, z, metresAcross, 'table' | 'screen')`.

## The two maps

| Map | Address | Size | What it adds |
| --- | --- | --- | --- |
| Central | `/` | 5.1 × 5.2 km | The city centre. Lighter to run. |
| West | `/?map=west` | 8.0 × 7.0 km | Älvsborgsbron and the far side of Tingstadstunneln, so all three river crossings are in play. About twice the buildings and vehicles. |

Every window has to use the same map, so on the west map the screens are `/?map=west&view=screen`.
The camera page is the same for both.

Each map is built from OpenStreetMap downloads kept in `data/` (central) and `data/west/`. To rebuild
one, or after changing its rectangle in `scripts/maps.mjs`:

```bash
node scripts/fetch-map.mjs west --again
```

```bash
node scripts/build-map.mjs west
```

Leave out `west` for the central map. The download server is often busy; the script retries, and
running it again later picks up where it stopped. To add another map, give it a name, a rectangle and
a rush-hour trip rate in `scripts/maps.mjs`.

## Where it departs from reality

- Demand is plausible, not measured. There are no real traffic counts behind it.
- Signal timings are generated from the junction layout, not taken from the city's controllers.
- Cars give way to trams where tracks cross a junction, but otherwise drive through them on shared
  streets.
- Pedestrians and cyclists wander rather than make planned trips.
- Other drivers do not pull over for the ambulance.
- Each window runs its own copy of the simulation. Screens show the same closures, time and place as the
  table, but not the identical cars.
- A tall object looks slightly further from the camera's centre than its base is (a few centimetres
  for a cup).
- There is no airport inside the map. Landvetter is 20 km east; the hospital helipads are drawn.

Map data © OpenStreetMap contributors.
