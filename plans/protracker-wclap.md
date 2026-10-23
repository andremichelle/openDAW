# ProTracker as a WebCLAP instrument

Port `../ProTracker` (PT 2.3A playroutine as 68000 code in a small Amiga emulator, `emu/ust.c`) into openDAW as a
WebCLAP instrument. Its user interface (pattern view, positions, channels, transport) becomes the plugin page in the
floating WebCLAP window. A mixer pans each of the four Paula channels. Playback follows the project tempo and the
project transport.

## WebCLAP or Apparat

WebCLAP. Apparat is not a realistic target.

1. **Code.** The emulator is C (Musashi 68000 core, 1.2 MB of C) compiled with `STANDALONE_WASM`, no imports. That is
   exactly what a WebCLAP `module.wasm` is. Apparat runs plain JavaScript without imports and without wasm, limited
   to 256 KB, so the 68000 core would have to be rewritten in JS.
2. **Window.** A WebCLAP page already opens in its own `FloatingWindow` (resizable, survives screen switches, keys
   forwarded). Apparat script views live inside the device panel.
3. **UI reuse.** The ProTracker UI is TypeScript on the openDAW SDK (lib-jsx, lib-dom, lib-std). It bundles with Vite
   into the plugin page as is.
4. **Host support already there.** The bridge writes a `clap_event_transport` every quantum (tempo, playing, song
   position in beats), persists `clap.state`, exposes CLAP params as automatable openDAW parameters and relays
   webview messages both ways.

## What the host gives us

1. Transport per 128 frame quantum: `HAS_TEMPO`, `IS_PLAYING`, `SONG_POS_BEATS` (`wclap-bridge.ts#writeTransport`).
2. Params: every CLAP param becomes a `WclapParameterBox` (automation, MIDI learn, modulation, Parameters menu).
3. State: `clap.state` blob saved base64 in the box field `state`, debounced after GUI traffic and on window close.
4. Webview: `clap.webview` page served from the bundle via the service worker on `opendaw-plugins.studio`,
   `host.send` / `receive` as the message channel.
5. Output: one stereo port. Per channel pan therefore happens inside the plugin, not in the openDAW mixer.

## Tempo

The routine programs CIA-B timer A itself: `latch = 1773447 / BPM` (50 Hz at 125). One row is `speed` ticks, so at
the default speed 6 a beat is 4 rows.

1. **Follow host (default).** The CIA timer no longer paces the routine. The plugin fires the routine's tick
   interrupt itself at each tick's musical position, at the exact frame inside the block (see Transport). The routine's latch writes are ignored, so `Fxx >= 32` (tempo commands) have no effect and
   `Fxx < 32` (speed) still applies, as in every tracker that syncs to a host.
2. **Module tempo (param, off by default).** Plays at the module's own BPM. Useful for listening, not for arranging.

## Transport and position

Project and tracker position are locked: the tracker is always where it would be had it played from project beat 0.

1. **Mapping.** Beats are locked, rows are not: four rows make a beat (a pattern delay `EEx` counts as its extra
   rows), and every tick of a beat fires at an even share of it. With a constant speed that is a row per 1/16 note.
   A shuffle (alternating speeds, kc-dancinonamiga plays 5, 3, 5, 3 = 16 ticks a beat) keeps its swing, at 187.5 BPM
   exactly the Amiga's 50 Hz ticks. `mt_init` leaves the routine 5 ticks before row 0, the snapshot pass runs them
   silently so row 0 plays at beat 0. The pass records every tick's beat (ending at a beat boundary after the song
   wrapped), a seek finds its tick by binary search. Past the pass (a looping song) each beat is measured when it
   starts, on a fork of the machine (snapshot, silent ticks, restore), about 0.1 ms per beat.
2. **Block range.** Each process call is one engine block, the musical time inside it never jumps. The plugin needs
   the block's start and end. Start is `song_pos_beats`. End comes from standard CLAP fields:
   `end = start + frames * (tempo + tempo_inc * frames / 2) / (60 * sampleRate)`. No bridge change is needed:
   the engine's transport (`crates/transport`) splits a quantum into blocks at every tempo change and gives each
   block one constant `bpm` with `p1 = p0 + samples_to_pulses(frames, bpm)`, so `tempo` alone yields `p1` and
   `tempo_inc` is 0 by construction. A host that ramps the tempo inside a block fills `tempo_inc`, which the
   plugin honours.
3. **Play / stop.** Edges of `IS_PLAYING` call `ust_play` / `ust_stop`. Stopped means silent, the module stays loaded.
4. **Jumps.** CLAP's transport has no jump flag, and none is needed: the plugin remembers the end of the previous
   block, and a new block that does not start there is a jump (seek or loop restart). With exact block ends this is
   an exact comparison, and it works in any host.
5. **Seeking.** The routine cannot seek. On a jump the plugin re-inits the routine and replays its interrupt for the
   target number of ticks with Paula muted and the CPU only running the tick handler. That is exact for every effect
   (pattern breaks, position jumps, E6x loops, EEx delays, speed changes). A 5 minute song is ~17000 ticks of a few
   thousand 68000 cycles each, measured in phase 0. If too slow, the plugin keeps machine snapshots (2 MB RAM +
   CPU/CIA/Paula registers) every N ticks and replays from the nearest one.
6. **Song end.** Past the last position the routine wraps like ProTracker. Whether it loops or stays silent after
   the end is a param.

## Mixer

`ust_render` today mixes Paula hard L R R L. The new render loop keeps four channel accumulators and mixes them with
per channel gains.

1. CLAP params per channel: **Pan** (-1..1, defaults -0.5 0.5 0.5 -0.5, a softer Amiga spread), **Volume**,
   **Mute**. Solo stays a page action that mutes the others, no extra param.
2. Global params: **Stereo Separation** (scales all pans, 0 = mono), **A500 Filter**, **LED Filter**,
   **Declick**, **Follow Host Tempo**.
3. Equal power pan law, computed once per quantum, not per frame.
4. The filter model stays after the mix, as now.

The page shows the mixer as a strip under the channel view, its controls write the CLAP params through the webview
gesture protocol, so automation and the Parameters menu stay in sync.

## State and modules

1. The mixer lives in params, so `clap.state` holds only a magic, a version, the module bytes and the page's view
   settings. A MOD is 2 KB to 1 MB, base64 in the box adds a third. The bridge already handles Six Sines'
   91 KB, a 1 MB module needs a size check (phase 1).
2. Modules come from the page: drop a `.mod` file, or the 8bitboy collection list. The collection is fetched from a
   url, never bundled into the plugin (license and bundle size).
3. `assets/ptplay` (5 KB) is compiled into the wasm as a byte array, so the plugin needs no extra file.

## Page

1. Reuse `src/ui` from ProTracker: `PatternView`, `Positions`, `Channels`, `Transport`, the visualizer stays out
   (WebGL in the plugin frame is a later question).
2. The plugin pushes replayer state (song pos, row, pattern, cells, per channel period/volume/dma) to the page at
   ~30 Hz through `host.send`, the page draws. No polling from the page.
3. The page sends: load module (bytes), select collection entry, solo/mute, and param gestures.
4. Transport buttons on the page are removed. The project transport is the only transport.

## Host independence

The plugin uses only standard CLAP: transport (`song_pos_beats`, `tempo`, `tempo_inc`, `IS_PLAYING`), params,
`clap.state`, `clap.webview`, one stereo output. It runs in any WebCLAP host. A host that does not fill `tempo_inc`
still works, the tick placement inside a block with tempo automation is then off by at most the tempo change across
one block, and the next block start corrects it.

## Licensing and distribution

1. The project code is MIT, Musashi is MIT. The playroutine is public domain: the ProTracker 2.3A ReadMe (1993) releases
   the distribution as Public Domain, the 2.3D help file repeats it. The README of the ProTracker repo lists every part.
2. The five example modules in `wclap/mods/` are free to share. The 8bitboy collection carries no license and never
   ships in the plugin.
3. Distribution through opendaw-commons is open.

## Phases

0. **Spike.** A C `clap_entry` wrapper around `ust.c` (instrument, stereo out, `process` calls `ust_render`, sample
   rate from `activate`), `ptplay` embedded, a fixed test module embedded. Build with the opendaw-commons flags,
   load it in node through `core-wasm/test` (like `wclap-bridge.test.ts`) and in the Studio via Import WebCLAP.
   Measure render cost per quantum and the seek replay cost.
1. **Transport + tempo.** Ticks fired from musical time, play/stop edges, jump detection, seek by snapshot +
   tick replay. No bridge change (see Block range). Node test: render
   at 120 and 140 BPM, check the row timing against the expected beats, jump and compare against a straight render.
2. **Mixer.** Per channel render, the params above. Node test: one channel hard left is silent on the right.
3. **State.** Module bytes in `clap.state`, size check, reload restores the module and the position.
4. **Page.** Vite build of the reused UI into the bundle page, state push, module drop + collection list, mixer
   strip. Browser check by you.
5. **Distribution.** Cloud catalogue upload, or opendaw-commons if the licence question resolves.

Editing patterns is not part of this plan, ProTracker is a player today. It would be a later phase on top of the
same page (the module bytes in the plugin are the document).

## Phase 0 results (2026-10-23)

Code in `../ProTracker/wclap/` (`protracker.c`, `build.sh`, output in `wclap/out/`, gitignored) plus
`ust_skip_ticks` in `emu/ust.c`. Benchmark in `core-wasm/test/protracker-spike.test.ts` (temporary, absolute paths).

1. **Build.** `module.wasm` 368 KB, `protracker.wclap.tar.gz` 70 KB, no imports. Emscripten 3.1.51 with the
   opendaw-commons flags, CLAP headers from `../open-webclap/external/clap/include`.
2. **Bridge.** Described as `[instrument, sampler, stereo]`, loads, plays while `PLAYING` is set, silent otherwise.
3. **Render cost.** 30 µs per 128 frame quantum in node, 1.1% of the 2.67 ms budget.
4. **Silent replay.** ~6200 68000 cycles per tick, 6.2 µs per tick. 1 min 19 ms, 5 min 92 ms, 10 min 190 ms. Lands
   exactly where real playback lands (000.delicate.mod, 60 s, both at 11:45).
5. **Consequence for seeking.** A full replay on the audio thread is far over budget. Snapshots solve it: when idle,
   the machine state is the routine's data hunk, the four Paula channels, CIA-B and the LED bit (a few KB, the CPU
   sits in the idle loop and the module data is never written). One snapshot every 128 ticks, built by a silent pass
   at module load (spread over quanta), caps a seek at 128 ticks = 0.8 ms. A 10 minute song needs ~235 snapshots.
6. **Paula after a seek.** The replay does not advance the channels' DMA positions, so a long sample that started
   before the seek point stays silent until its next note. Phase 1 advances them analytically per skipped tick
   (period, length and loop are known), which is cheap.

## Phase 1 results (2026-10-23)

1. **Musical time.** `ust_set_external_clock(1)`: CIA-B and the CPU stand still in `ust_render`, the plugin fires
   `ust_tick` at the frame where the position crosses `k / 24` beat. 16 beats take exactly 1.5x the frames at 100 BPM
   as at 150 BPM.
2. **Snapshots.** Built at activate by a silent pass (nominal 125 BPM), every 128 ticks, until the song wraps or
   2^17 ticks. 5149 bytes each.
3. **Invert Loop.** `EFx` rewrites sample bytes in the module (`MOVE.B D0,(A0)` in `mt_UpdateFunk`), which the
   first snapshots missed (jumps past the third snapshot of 000.delicate.mod correlated 0.91). The emulator now
   journals every CPU write into the module range (address, old, new). A snapshot stores the journal position,
   restoring walks the journal back or forth, replaying the same timeline walks over the recorded writes.
4. **Paula at any tempo.** The silent pass logs every tick's channel registers and every DMA restart. A seek rebuilds
   each running channel from its last restart at the current tempo's tick length (`ust_paula_rebuild`), so a long
   sample that started before the jump plays from the right spot. Under tempo automation it assumes the current
   tempo since the restart.
5. **Verified** (`core-wasm/test/protracker-spike.test.ts`, through the real bridge): jumps to 7 block aligned
   targets up to block 40000 at 125, 140 and 97.3 BPM correlate 0.995 to 0.999999 with straight playback. The rest
   is Paula's sub-frame decimation phase. Render cost 23 µs per quantum.
6. **Known limits.** Seeking beyond the snapshot pass (after the song wrapped) replays from the last snapshot, slow
   for a far target. The song end param (loop or silence) settles that. The snapshot pass runs at activate, ~90 ms
   for a 5 minute song, on the audio thread in openDAW today.

## Phase 2 results (2026-10-23)

1. **Emulator.** `ust_set_mix(channel, left, right, ramp)` turns on a mixer: four channel sums per frame, each into
   left and right with gains that ramp linearly over `ramp` frames. Until the first call the old hard L R R L path
   runs, the web player renders byte identical to the original `ust.c` (native harness, 000.delicate.mod, 5 s).
2. **Params** (ids 0 to 14, CLAP `module` = "Channel n" for the channel ones): Pan 1-4 (-1..1, defaults -0.5 0.5
   0.5 -0.5, shown as L50/C/R50), Volume 1-4 (0..1), Mute 1-4 (stepped), Stereo Separation (0..1), A500 Filter
   (stepped, on like the web player), Declick (stepped, off). Equal power pan, separation scales every pan. Param
   events apply at the block start, gains ramp over the block.
3. **Left out.** An LED filter param (the module switches it with `E0x`) and a "module tempo" mode, which would
   break the sync. Solo stays a page action (phase 4).
4. **Verified** through the bridge: 15 params reported in order, all channels hard left leaves the right side at
   1.4e-45 (the A500 filter's tail), separation 0 makes left and right identical, all muted is silent.

## Phase 3 results (2026-10-23)

1. **State.** `clap.state`: magic `PTWC`, version 1, param count, the 15 params as doubles, module length, module
   bytes, little endian. The plugin keeps its own copy of the module (the compiled in test module until a state
   arrives). Loading swaps the module, rebuilds the snapshots and seeks on the next block. An invalid state (magic,
   version, param count, sizes, 4 MB cap) leaves the current module playing.
2. **Song end.** The snapshot pass now stops at any backward position jump, not only a wrap to position 0. TLITS.MOD
   loops with a backward `Bxx` and ran the pass to its cap: 749 ms, now 31 ms for the whole state load.
3. **Verified** through the bridge: the saved state holds params and module byte exact, a TLITS state swaps the module
   (correlation 0.999998 with a fresh plugin given the same state, 0.03 with delicate), an invalid state keeps TLITS.
   The plugin re-saves exactly what it loaded, so the bridge reports no change.
4. **Storage.** In openDAW the state is base64 in the string field 12 until `plans/wclap-state-bytes.md` lands.
5. **Open.** The params are in the state for other CLAP hosts. In openDAW the parameter boxes are the truth, the
   bridge pushes their values after a state load, to be checked in the browser.

## Phase 4 results (2026-10-23)

1. **Plugin.** `clap.gui` (webview api only, 960x640, resizable, at least 640x420) and `clap.webview/3`: `get_uri` is
   `/index.html` of the bundle, `get_resource` declines (the host serves bundle files). Binary messages, little
   endian. Page to plugin: poll (1), module request (2), load (3, module after a 4 byte header), param begin, set,
   end (4, 5, 6). Plugin to page: status (1, 148 bytes: playing, pos, pattern, row, speed, song length, module
   serial, 4 channels period/volume/dma, 15 params), module (2, serial + bytes). The page polls once per animation
   frame and the plugin answers inside `receive`, so all sends are on the main thread and a closed page costs
   nothing. The status is captured at every block start in `process`.
2. **Edits from the page** are queued and drained into the out events of the next `process` or `params.flush`
   (`request_flush`): gesture begin, value, gesture end, as any CLAP host expects. openDAW writes the value into the
   parameter box, gestures only mark the edit.
3. **Module loads from the page** are copied in `receive` and swapped in at the next block start on the audio thread,
   `clap.state.mark_dirty` makes the host save. The serial counts swaps, the page fetches the module when it changes.
4. **Page** (`src/wclap/`, entry `wclap/page`, `vite.wclap.config.ts`, built into the bundle by `wclap/build.sh`):
   `PluginLink` implements the new `Replayer` interface (`src/Replayer.ts`), which `PatternView`, `Positions` and
   `Channels` now take instead of `Player`, so the page reuses them unchanged. Header with title, play state, the
   8bitboy collection (fetched from the GitHub Pages site, not bundled) and Load file, drop a file anywhere. Mixer
   strip: pan and volume faders (one gesture per drag), mute and solo per channel, separation, A500 and Declick.
5. **Verified** through the bridge: `openGui` answers `/index.html` at 960x640, the status after 2 beats, the module
   request returns delicate byte exact, a pan drag reaches the host as begin, -0.25, end, a TLITS load swaps the
   module (serial 1) and lands in the saved state with the dragged pan. ProTracker's own tsc, 25 tests and web build
   still pass. Bundle 106 KB gzipped.
6. **Not verified.** The page in a browser (layout, the collection fetch from the plugin origin under COEP, drag and
   drop inside the plugin frame).

## Open questions

1. Player only, or should the plan include pattern editing later?
2. Distribution: settled, opendaw-commons (see Licensing and distribution).

## May break

1. **Snapshot pass on the audio thread.** Loading a module or a project runs the snapshot pass inside `process`,
   ~90 ms for a 5 minute song, longer for longer songs up to the 2^17 tick cap. A realtime render may drop out once at
   load. Observed, not fixed. The fix would build the snapshots on the main thread and swap them in when ready.
