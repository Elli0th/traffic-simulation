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
