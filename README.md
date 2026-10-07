# Tangible Table · Göteborg

> **Looking for the latest version?** The branch that got furthest is
> [`game-room-api`](https://github.com/Elli0th/traffic-simulation/tree/game-room-api): the outbreak
> game, the connection to the room and the streaming to its displays, with a guide to every branch in
> its README. This branch, `room-api`, is the traffic simulation with the connection to the room and live traffic, before the game was added. It is kept for reference, and the
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

## Planning a change

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
| Screens | `/?view=screen` | The TVs. They follow the table: same objects, clock and area, in 3D. |
| Camera | `/camera.html` | Your laptop. Keep this window visible; browsers slow down hidden pages. |
| Lidar | `/lidar.html` | Your laptop, also visible. Turns hands over the table into map movements. |

### Setting up, in order

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
