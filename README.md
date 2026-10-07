# Tangible Table · Göteborg

A projected table you can touch, built at the AID 2026 hackathon (Aixia, October 2026). Two things
run on the same map of Gothenburg:

- **Outbreak**, a game for one or two players: one side spreads a virus through the city, the other
  curbs it. It is played with fingers on the table, with two TVs as each side's dashboard and the
  room's lights following the outbreak.
- **A traffic simulation**: put an object on a street and the street closes, and the city's traffic
  reacts around it. With two free API keys it follows what Gothenburg's roads, trams and buses are
  doing right now.

The room it was built for has a ceiling projector over a table, a lidar along the table's edge, two
TVs and Philips Hue lights, each with its own small HTTP and WebSocket API. Everything here runs on
one laptop; the room's own computers only show pictures.

## Start here: which branch

**`game-room-api` (this branch) is the one that got furthest.** It holds the game with every feature
the team built, the connection to the room, and the streaming that lets a laptop drive all three
displays. If you read one branch, read this one.

| Branch | Who | What it is | Compared with this branch |
| --- | --- | --- | --- |
| **`game-room-api`** | Ellioth Nyman | The game, the room connection, streaming, lidar touch | This one |
| `virus-game` | jjianhhao, Abhijith, Wen Xi, Tia | The team's shared branch for the game's rules and screens. Merged into this branch on 7 October | Has four later commits not merged here: the projector stream encoded in a worker, two layout fixes, and a seismic trench placed by fitting a line to lidar taps |
| `main` | Ellioth Nyman | The first version: the traffic simulation only | Fully contained here |
| `room-api` | Ellioth Nyman | The traffic simulation with the room connection and live traffic, before the game | Contained here, bar its launch configuration |
| `single-player` | Tia | The solo roles, as a pull request | Merged into `virus-game`, and so into this branch |
| `table-demo` | Abhijith | A separate demo of a touch surface with sliders, camera projection and lights | A different experiment; not merged |
| `game-winner`, `plague-game` | Ellioth Nyman | Earlier takes on the game, one with a winner and government approval | Superseded: the team dropped the winner |
| `game-room-api-next` | Ellioth Nyman | A staging copy used to try a merge | Superseded |
| `tiya_test` | jjianhhao | A test branch | Fully contained here |

### What state it is in

Written on 7 October 2026, at the end of the event.

| | State |
| --- | --- |
| The game on a laptop, mouse and keyboard | Works. Solo as Spreader, solo as Government, and two players |
| The automated checks (`npm test`) | All pass: the outbreak model, the solo balance, the trench, the dashboards, the view geometry |
| Streaming the table to the real projector as JPEG frames | Worked in the room. The sharper settings added afterwards were only tried against stand-in displays |
| Streaming to the two TVs from the same window | Worked in the room once; the same caveat |
| Streaming as video (WebRTC) | Worked between two windows on one laptop. Never tried on the room's displays |
| Finger touch from the lidar | The engine came from `virus-game`, where it worked on the table. Pressing on touch-down, swiping to scroll and the solo handling were added here and only checked in a timing simulation |
| The virtual room (the organisers' Docker copy of the room) | The stream reached its projector and TVs. Its lidar was not checked against the table box |

## Run it

Node 20.19 or later.

```bash
npm install
npm run dev
```

Open http://localhost:5173. It asks whether you want the game or the traffic viewer.

| Address | What you get |
| --- | --- |
| `/` | The question: Outbreak game or Traffic viewer |
| `/?game` | The game with mouse and keyboard. It does not listen to the lidar or need the room |
| `/?game&players=1&role=spreader` | Straight into a solo round as the Spreader (`role=curber` for the Government) |
| `/?game&players=2` | Straight into a two-player round |
| `/?traffic` | The traffic simulation of the city centre (`&map=west` for the larger map) |
| `/stream.html` | The page that renders everything and sends it to the room's displays |

`&lights=0` on any game address keeps it from touching the room's Hue lights, for a laptop that is
on the room's network without having the room.

```bash
npm test
```

## The game

A round is three real minutes, which stands for 60 days. There is no winner: it ends with a summary
of how far the virus went.

**Two players** share the table. The Spreader has the left half and the Curber the right, each with
their own map of the same city, their own zoom, and their own panel of actions. Each side only sees
its own pins: the Spreader's parties, the Curber's lockdown zones. The Spreader's first touch on a
busy street places patient zero.

**Solo** is one map across the whole table against the computer.

- *Solo · Spreader*: infect as much of the city as you can. Powers unlock as the virus spreads: move
  patient zero at 8% infected, a festival at 20%, a blackout at 30%, a mutation at 40%.
- *Solo · Government*: an outbreak starts by itself and a computer Spreader works against you. At 25%
  protected, or after 20 seconds, you get the seismic trench: a line across the map that the virus
  and people cannot cross for the rest of the round.

Solo rounds can be paused. The computer players are `src/curber-ai.js` and `src/spreader-ai.js`.

| Player / key | Action | Starts after | What it does |
| --- | --- | --- | --- |
| Spreader `Q` + click | Start a party | At once | The nearest people within 300 m gather and mix |
| Spreader `W` | Antimask conspiracy | 5 min | Contact transmission ×1.4 for 30 min |
| Spreader `E` | Antivaxx conspiracy | 5 min | Vaccine acceptance falls from 85% to 25% for 40 min |
| Spreader `R` + click | Send someone sick to work | At once | The nearest infectious person stays out and avoids isolation for 15 min |
| Spreader `A` | Spread fake news | 3 min | Contact transmission +20% and isolation half as likely, for 30 min |
| Curber `I` + click | Lockdown | 1 min | A 220 m zone keeps 90% of people home for 30 min |
| Curber `O` | Free vaccines | 2 min | A citywide rollout for 30 min |
| Curber `P` | Social distancing | 1 min | Contact transmission ×0.55 for 30 min |
| Curber `L` | New hospitals | 10 min | Cases are found and isolated faster, for the rest of the round |
| Curber `K` | New vaccine | 20 min | Vaccination protects 90% instead of 65%, for the rest of the round |
| Curber `J` | Health education | 2 min | Contact transmission −20% and more isolation, for 30 min |

The times are simulated minutes; the game runs at 30× speed, so 5 minutes is 10 real seconds. Solo
uses its own cheaper, faster set. Costs, delays, durations and cooldowns are in `ACTIONS` in
`src/virus.js`.

### How the virus spreads

About 2,000 simulated people walk and cycle the real paths of the city between homes and
workplaces. Each stands for about 290 of Gothenburg's 600,000 inhabitants, and the counts on screen
are in real people.

- Everyone is susceptible, exposed, infectious or recovered. Exposed becomes infectious after about
  3 game days; infectious lasts about 8; recovered is immune for the round. Both times vary by ±30%.
- Once a simulated second, a susceptible person within **18 metres** of an infectious one may catch
  it: about a 3% chance a second for each infectious person in range, before anything modifies it.
  The chance does not fall with distance inside those 18 metres. The radius is large because one
  simulated person is a crowd of 290.
- Built-up districts are riskier (×0.5 to ×2.5 by how much floor area is around). Being indoors,
  being isolated, or a trench in between blocks it entirely.
- Trams, buses and cars can carry the virus in the model. The playable game leaves vehicle movement
  out to stay fast.

The timings follow the original COVID-19 strain (R0 about 2.5, 5% needing a hospital bed, 0.7%
dying). It is a game model, not a forecast.

## In the room

### How it is put together

```
            the laptop                                      the room
 ┌───────────────────────────────┐
 │ dev server (Vite)             │──── lidar sweeps ◄────── lidar (WebSocket)
 │  · passes the lidar on        │──── light colours ─────► Hue bridge (HTTP)
 │  · relays frames to displays  │──── JPEG frames ───────► projector, TV 1, TV 2
 │  · relays messages between    │      (or video, peer to peer)
 │    the pages                  │
 ├───────────────────────────────┤
 │ stream page (one browser tab) │
 │  ┌─────────┐ ┌──────┐┌──────┐ │
 │  │ the game│ │ TV 1 ││ TV 2 │ │   the three pictures are cut out of this
 │  │ (table) │ │ dash ││ dash │ │   one tab and sent to their displays
 │  └─────────┘ └──────┘└──────┘ │
 └───────────────────────────────┘
```

The displays' own computers are Raspberry Pis, too slow to run the game. So nothing runs on them:
`stream.html` holds the table and the two TV dashboards in one browser tab on the laptop, the
browser shares that tab with the page, and the page cuts out each picture and sends it on.

**Frames.** Each picture goes as JPEGs through the dev server (`scripts/frame-relay.mjs`), which
holds each display's WebSocket. After every frame it sends a WebSocket ping, and the page sends more
only when the display's answer is back. So a slow wifi gives fewer frames a second, never a picture
that has fallen behind. The table is sent at up to 30 frames a second and never narrower than 1280
pixels; a TV at up to 8, and not at all while its picture has not changed.

**Video.** With `?via=video` each display instead shows `/watch.html`, a page that only plays a
WebRTC video sent straight from the laptop. Video sends only what changes, so the projector's full
1920 × 1200 costs a few megabits a second. A display whose video has not connected after eight
seconds gets frames instead. This path was never tried on the room's displays.

### A slot, step by step

`docs/slot.md` is the runbook. In short, from this folder, with the laptop on the room's wifi:

```bash
npm run live
```

```bash
npm run room boot
```

`boot` checks the wifi, the server and the lidar, and opens the stream page. Nothing reaches a
display until **Start streaming** is pressed there and the browser is allowed to share the tab; that
click is deliberate, so that opening a page can never take the room from another team.

| Command | What it does |
| --- | --- |
| `npm run live` | The dev server on port 5203 (`npm run live:record` also records the session) |
| `npm run room boot` | Checks everything and opens the stream page on the game |
| `npm run room show` | The stream page on the traffic view (`show map=west` for the larger map) |
| `npm run room video` | The game as video: puts `/watch.html` on the displays and opens the stream page |
| `npm run room show check` | A test card on the projector: crosses to try the lidar against |
| `npm run room status` | What each display is showing, and from which address |
| `npm run room idle` | Hands the displays back |

Useful additions to the stream page's address: `&tvs=0` leaves the TVs alone, `&lights=0` leaves the
lights alone, `&res=1920` keeps the table at the projector's full size and gives up frames a second
instead.

### Touch

The lidar sweeps a plane just above the table ten times a second. `src/room/lidar-touch.js` turns
each sweep into touches:

1. Every reading is an angle and a distance, which gives a point in millimetres from the lidar.
2. Points outside a fixed box are dropped. The box is where the projected picture is: 1440 mm wide
   and centred on the lidar, from 150 mm to 1050 mm in front of it.
3. Points within 80 mm of each other are one touch, if there are at least two of them.
4. The touch's place in the box is its place in the picture, mirrored left to right, and from there
   it is handled like a mouse at that pixel: a button is pressed, or the map is clicked.

A press counts as soon as a finger has been seen in two sweeps running, about a tenth of a second
after it lands, and once per touch. On a list that has more than fits (it shows a blue scrollbar),
a finger slid along the list scrolls it, and a press there counts when the finger lifts.

There is no calibration. If the picture is not where the box assumes, `&box=left,right,near,far` on
the stream page's address gives the measured edges in millimetres, and `&lidarmm=1` writes each
touch's own millimetres on the table so the four corners can be read off it. `[` `]` `{` `}` slide
the box by 10 mm. A box cannot correct a lidar that is turned or a picture that is not a rectangle.

Two fingers held together register more reliably than one: a single fingertip more than about a
metre from the lidar is often caught by only one beam.

### TVs and lights

- **TVs** (`dashboard.html`): each side's own dashboard, with its last actions, where to act next,
  hospital load or vaccination progress, and points. In a solo round the left TV turns to a 3D view
  of the city (`tv-map.html`) that shows the game's own people, and the right one follows the role.
- **Lights** (`src/room/hue-lights.js`): the left lights are the Spreader's red, the right ones the
  Curber's green, and the middle ones turn towards whoever is ahead. They go only through the dev
  server, so a server pointed at the virtual room cannot change the real lights.

### Rehearsing without the room

The organisers publish a copy of the room that runs in Docker and answers like the real one
(`aixia-ab/aid-hackathon-room`, in `sim/`). A dev server pointed at it needs these in front:

```bash
ROOM_ENV=sim PROJECTOR=http://localhost:8021 TV1=http://localhost:8022 TV2=http://localhost:8023 ROOM_LIDAR=http://localhost:8024 npm run dev
```

Its 3D view at http://localhost:8000 then shows what the table and the TVs would show.

## The traffic simulation

`/?traffic`. The game is built on top of this.

- **Streets**: the real network from OpenStreetMap, with speed limits, lanes, one-way streets and
  turn bans.
- **Driving**: every vehicle follows the Intelligent Driver Model: it accelerates, keeps a gap and
  brakes for what is ahead, slows for bends, changes lanes and never overlaps another.
- **Junctions**: 179 signalled junctions in the centre with traffic-actuated lights, give-way and
  roundabout rules, and left turns that wait for a gap.
- **Demand**: trips between homes, workplaces and the edges of the map, weighted by floor area,
  following a daily profile with two rush hours. Drivers pick routes by current travel times.
- **Public transport**: trams on their real lines, buses on 141 real routes, ferries on the river.
- **People**: pedestrians and cyclists who wait for the green man.
- **Day and night**: sunrise and sunset for early October.

| Input | Effect |
| --- | --- |
| Click | Place an object, or remove the one under the cursor. An object closes the street under it |
| Drag | Move an object |
| Scroll | Zoom, or resize the object under the cursor |
| Right-drag, arrow keys | Pan |
| `0` | Whole city |
| `V` | Top-down table view, or the 3D view (`?view=screen` starts in 3D) |
| `1` `2` `3` `4` | Speed: 1×, 3×, 10×, 30× |
| Space, `T` | Pause; jump an hour ahead |
| `+` `-` | More or less traffic |
| `H` `C` `F` | Hide the panel, clear all objects, fullscreen |
| `L` | Live traffic on or off |
| `M` | Switch between the traffic view and the game |

The panel turns the map into a what-if tool: close a street, take or add a lane, schedule roadworks
between two hours, or draw a new road. **Compare** runs the next two hours or the whole day twice in
the background, with and without the plan, and shows speed, trip time, hours driven, trips completed
and the ambulance's time side by side.

### Live traffic

Copy `.env.example` to `.env.local`, fill in the two free keys and restart the server.

| Source | What it gives | What the map does with it |
| --- | --- | --- |
| Trafikverket, road sensors | Speed and flow at measuring sites, every minute | Drivers near a site go no faster than traffic there really is; the number of trips follows how full the measured lanes are |
| Trafikverket, incidents | Accidents, roadworks and other reports | A pulsing ring; an accident also takes a lane and slows its street |
| Västtrafik, vehicle positions | Every tram, bus and ferry, every five seconds | The real trams, buses and ferries replace the simulated ones |

The cars stay simulated, since nobody publishes where every car is. The dev server fetches the data
(`scripts/live.mjs`), so the keys never leave the laptop.

### The two maps

| Map | Address | Size |
| --- | --- | --- |
| Central | `/?traffic` | 5.1 × 5.2 km: the city centre |
| West | `/?traffic&map=west` | 8.0 × 7.0 km: adds Älvsborgsbron, so all three river crossings are in play |

The built maps are in `public/`, which is all the app needs. The raw OpenStreetMap downloads they
were built from (about 125 MB) are not in the repository: `node scripts/fetch-map.mjs west --again`
fetches them into `data/` and `node scripts/build-map.mjs west` rebuilds the map; `scripts/maps.mjs` names the
maps and their rectangles.

### Objects and hands on the traffic view

Before the game, the table drove the traffic view, and those pages are still here:

- `/lidar.html` reads the lidar for the traffic view: one moving hand drags the map, two hands zoom
  it, and anything that stands still for a second is an object that closes the street under it. It
  has its own nine-point calibration, which the game no longer uses.
- `/camera.html` does the same from a depth camera, with a simulated one to rehearse with.
- `/draw.html` is light painting: a hand over the table leaves a glowing ribbon.
- `/check.html` is the test card.
- `npm run live:record` writes every lidar sweep and every message between the pages to
  `recordings/`; `node scripts/recording.mjs <file>` summarises a recording.

## Where things are

| Path | What is in it |
| --- | --- |
| `index.html`, `src/main.js` | The table page: both the traffic view and the game, its drawing and its input |
| `src/sim.js`, `src/transit.js`, `src/people.js`, `src/world.js` | The traffic simulation: vehicles, public transport, pedestrians, and the city's 3D model |
| `src/virus.js` | The outbreak model and the actions. No drawing |
| `src/curber-ai.js`, `src/spreader-ai.js` | The computer players |
| `src/game-view.js`, `src/game-runtime.js` | The game's layout on the table, and its lightweight simulation loop |
| `src/trench-effects.js`, `src/trench-geometry.js` | The seismic trench |
| `src/room/lidar-touch.js` | Finger touch from the lidar, for the game |
| `src/room/stream.js`, `stream.html` | The stream page |
| `src/room/watch.js`, `watch.html` | What a display shows when it is sent video |
| `scripts/frame-relay.mjs` | The dev server's side of streaming frames |
| `src/room/hue-lights.js` | The lights |
| `dashboard.html`, `src/room/dashboard-data.js` | The TV dashboards |
| `tv-map.html`, `src/tv-map.js`, `src/room/game-broadcast.js` | The 3D city on a TV, and the snapshot the game sends it |
| `src/room/relay.js` | Messages between the pages, through the dev server and between tabs |
| `src/live.js`, `scripts/live.mjs` | Live traffic |
| `scripts/room.mjs` | `npm run room …` |
| `vite.config.js` | The dev server: the relays and the addresses of the room's devices |
| `scripts/test-*.mjs` | The checks behind `npm test` |
| `docs/slot.md` | The runbook for a slot in the room |

## What is not there, or not right

- Touch on the real table was not confirmed with this branch's last changes. The first thing to do
  in the room is one tap on the menu.
- The table box for the lidar is measured for one room. Another room needs its own four numbers.
- The picture is cut out of a browser tab, so its sharpness depends on how large that window is. On
  a small screen the two TV pictures are soft.
- The stream needs a click in the browser every time it starts, and reloading the stream page stops
  it. Saving a source file while streaming reloads the page.
- The TV dashboards follow whichever game page started most recently. A second game opened on the
  same server takes them over.
- The lights' API key is in `src/room/hue-lights.js`. It only works on the room's own network.
- In the traffic simulation, demand is plausible rather than measured, signal timings are generated
  from the junction layout, and each window runs its own copy, so screens show the same closures and
  clock as the table but not the identical cars.

## Who built it

Ellioth Nyman, Abhijith, jjianhhao, Wen Xi and Tia, at the AID 2026 hackathon.

Map data © OpenStreetMap contributors. Traffic data from Trafikverket and Västtrafik.
