# Our slot: calibrate and watch the inputs

The plan for the slot is to calibrate the lidar properly and record what it sees, not to show the
game. The projector shows a light test card by address; nothing is streamed to it.

Run everything from the live folder, `.claude/worktrees/game-room-api`.

## Before the slot (no hardware needed)

1. The laptop is on the room wifi `AID-Hackathon-5G` (an address starting 192.168.42).
2. Brave is the browser for the lidar page: it holds the saved empty table and calibration.

## In the slot

1. **Start the server, recording.**

   ```bash
   npm run live:record
   ```

   It prints `recording to recordings/<date>_<time>.jsonl`. From here on every lidar sweep and
   every message between the pages is being written down. `http://localhost:5203/record/status`
   shows that it is.

2. **Open the lidar page in Brave and keep it visible** (not behind another tab):
   `http://localhost:5203/lidar.html?room`

3. **Put the test card on the projector.** This is the only step that touches the projector.

   ```bash
   npm run room show check
   ```

   The table shows nine crosses and says "Lidar page connected".

4. **Capture the empty table.** Everything and everyone off the table, then press
   "Capture the empty table" on the lidar page and wait three seconds. Check "Nearer by" is at
   60 mm, not 30.

5. **Calibrate.** Press Calibrate. Nine circles appear on the table, one at a time. Hold one
   fingertip still on the middle of each until its ring fills. If the table says it can see more
   than one thing, take everything else away. At the end it says how well the nine agree: under
   3% is good; over that, do it again.

6. **Try it.** Hold a fingertip still on each cross for a second. The ring turns amber and the miss
   is written under the cross, in percent of the picture and in millimetres. Green is under 2%.
   Then drag one hand across, and spread two hands: the readout in the middle follows.

7. **Things worth doing on purpose, because they are all recorded:**
   - a quick tap, a slow tap and a held finger on the same cross
   - a single fingertip at the far edge from the lidar, and again with two fingers together
   - a forearm resting on the table, and a sleeve passing over it
   - someone walking round the table while nobody touches it
   - say out loud, or note the time, when something registers that should not have

8. **Hand the room back** when the slot ends.

   ```bash
   npm run room idle
   ```

   Then stop the server (Ctrl+C). The recording is complete once the server has stopped.

## A slot that shows the game

Everything runs on the laptop only. None of the displays' own computers (Raspberry Pis) runs a
page: the laptop streams the finished pictures to the projector and both TVs. Start the server
(`npm run live`, or `npm run live:record`), then:

1. **Take the room for the game.**

   ```bash
   npm run room boot
   ```

   It checks the wifi, the server and the lidar and opens the stream page in Brave: one window
   with the table and the two TV dashboards in it. Nothing is on any display yet: press **Start
   streaming** on that page and allow it to share the tab. Keep that window visible and as large
   as the screen allows (the pictures are cut out of it). The status line says how many frames a
   second each display is getting: at most 30 for the table, 12 for each TV.

2. **No calibration for the game.** Its touch is the virus-game branch's: the table is a fixed box
   in front of the lidar. If taps land off, `[` and `]` nudge them 10 mm down and up, `{` and `}`
   left and right, with the game window in front; the nudge is remembered. (The lidar page and
   its nine circles are still what the traffic view uses.)

   **Measuring it instead of nudging.** The box is where the projected picture is, in millimetres
   from the middle of the lidar: left edge, right edge (sideways, left negative), near edge, far
   edge (straight out). Add `&lidarmm=1` to the stream page's address and put two fingers together on
   each corner of the picture: the table writes that touch's `x` and `y`. Then give the four numbers
   once, for example `&box=-715,725,160,1055`; it is remembered. A tape measure gives the same
   numbers. If the two near corners do not read the same `y`, the lidar is turned or the picture is
   not a rectangle, and no box will fit: straighten the lidar or the projector's keystone.

3. **Play.** A touch presses what is under it as soon as the finger is down (about 0.1 s), once per touch: the menu, the action buttons, the
   power cards, Pause and Resume, End game. In a solo round the whole table is the one player's.
   The seismic trench takes two taps, its start and then its end (the mouse drags it).
   The left TV turns to the 3D city in a solo round and the right one follows the role.

4. **Hand the room back** with `npm run room idle`, then stop the server.

## A sharper picture: video instead of frames

Frames are single JPEGs, one after the other: heavy on the wifi, so the page has to send fewer
pixels or a rougher picture to keep up. Video sends only what changes, so the table gets the
projector's full 1920 × 1200 for a few megabits a second, and it stays on time.

```bash
npm run room video          # game: table and both TVs
npm run room video table    # game: the projector only
```

Each display is given `/watch.html`, a page that does nothing but play the video, and the stream
page opens with `via=video`. If a display's video has not connected after eight seconds, that
display gets frames instead, so the worst case is the frames way. Press **Start streaming** as before. The status line says `Video:` and
the size and megabits of what each display is being sent. Not yet tried on the real displays: if a
display stays black, `npm run room boot` is the frames way, which is.

## Rehearsing in the virtual room

The organisers' virtual room (Docker) answers like the real one and shows it in 3D.

```bash
cd ~/aid-hackathon-room/sim
docker compose -f compose.yaml -f compose.local.yml up -d
```

`compose.local.yml` moves the virtual projector to port 8031, because 8021 is taken on this laptop.
The 3D view is http://localhost:8000. A dev server pointed at the virtual room is the launch entry
`game-sim` (port 5253); its stream page is http://localhost:5253/stream.html?mode=game. Lights and
lidar go to the virtual ones too. `docker compose down` stops it.

## Afterwards

```bash
node scripts/recording.mjs recordings/<file>.jsonl
```

says what is in the recording: how long, how many sweeps a second, how many clicks and
calibrations. With that file the calibration and the thresholds (how long a tap, how wide a
finger, how near "nearer" is) can be worked out from what really happened.

## If something is wrong

| What you see | What to do |
|---|---|
| The card says nothing is heard from the lidar page | The Brave tab is hidden or closed. Bring it to the front. |
| The lidar page says it has no connection | The laptop has left the room wifi, or the lidar has no power. |
| The projector shows nothing after step 3 | `npm run room status` says what it is showing. It can take 20 seconds to answer. |
| Rings appear with nothing on the table | Capture the empty table again; raise "Nearer by". |
| Calibration keeps saying it sees several things | Someone is leaning on the table, or the empty table was captured with something on it. |
