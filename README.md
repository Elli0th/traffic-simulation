# Tangible Table · Göteborg

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

## Outbreak game (two players)

Open http://localhost:5173/?game. Two side-by-side cameras show the same city and outbreak.
Spreader is on the left, Curber on the right. Each has independent + / - / Whole map buttons,
scroll zoom and right-drag pan. Actions target only their owner's map; selecting an action on one
side never arms the other side. The top bar spans both sides and shows current infected (exposed
plus infectious) and non-infected (susceptible plus recovered) totals. All people use red/green dots,
including people currently indoors. Isolation and vaccination status are not revealed by dot colour.
Only the Spreader sees party markers; only the Curber sees lockdown rings/closures. No opponent
action announcements are shown. Points, action buttons and cooldowns sit in covered panels; click
Show / hide to open your panel, which closes when you choose an action. Only one panel opens at a time.
A shared screen still lets someone physically look across; this is visual separation, not secure device privacy.
Click a busy street to place four initial exposed people for free.
The round runs three real minutes; at 30? that is 90 simulated minutes. All action timings below
use simulated time. This is an accelerated fictional game model, not a prediction for any disease.

| Player / key | Action | Delay | Effect / duration |
| --- | --- | --- | --- |
| Spreader Q + click | Start a party (10 pax) | Immediate | Ten nearest people within 300m; extra group contacts for 10m |
| Spreader W | Antimask conspiracy | 5m | Contact transmission ?1.4 for 30m |
| Spreader E | Antivaxx conspiracy | 5m | Vaccine acceptance falls from 85% to 25% for 40m |
| Spreader R + click | Send someone sick to work | Immediate | Nearest infectious person within 300m stays outside and evades isolation for 15m; lockdown still applies |
| Curber I + click | Lockdown | 1m | 220m zone keeps 90% of people home for 30m and cancels party contacts there |
| Curber O | Free vaccines | 2m | Citywide rollout for 30m; each unvaccinated person has an 85% / 600 per-second uptake chance (25% / 600 during antivaxx) |
| Curber P | Social distancing | 1m | Ordinary transmission ?0.55 and party transmission ?0.45 for 30m |
| Curber L | New hospitals | 10m | Permanent 0.3% per-second chance of isolating each infectious person |
| Curber K | New vaccine | 20m | Permanent improvement from 65% to 90% susceptibility reduction for vaccinated people |

Vaccination protects after another 5m and does not cure existing infections. Vaccinated people can
still catch and transmit infection. A party adds a hazard of 0.004 per infectious attendee per second
(about 21% risk over one minute with one infectious attendee, before protection/distancing).
Ordinary close contact uses a hazard of 0.1 per second within 18m. These intentionally accelerated
rates depend on the actual crowd, movement and interventions; they are not fixed citywide infection rates.
Incubation averages 90 seconds; infectious duration averages 30m, both with ?30% variation.
Recovered people are immune for the round. Hospitals represent isolation capacity, not deaths or treatment outcomes.
Action costs, delays, durations and cooldowns are in `ACTIONS` in `src/virus.js`.

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

1. **Get the table picture onto the projector.** If the projector's computer can open a web page, open
   the table address there. If it only accepts pictures, open the table on your laptop with
   `/?push=<address>&fps=8`, which sends each frame as a JPEG; adjust `pushFrame` in `src/main.js` to
   the request the room expects.
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

The lidar on the table's long edge sweeps just above the surface, so it sees hands reaching over.
On the lidar page, connect, capture the empty table and calibrate the same way as the camera, but
by holding a finger on each glowing circle. Then:

- **One hand moving** drags the map.
- **Two hands moving apart or together** zoom in or out.
- **Anything that stays still for a second** is treated as an object and does not move the map.

The page expects sweeps as JSON, either `{ angle_min, angle_increment, ranges }` or a list of
`{ angle, distance }`. `decodeScan` in `src/room/scan.js` is the one place to change if the room's
lidar sends something else. If the lidar is not at the top edge, calibration takes care of it.

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
