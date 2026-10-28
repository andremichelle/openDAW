# Glitchfest

A glitch audio effect for the WebCLAP site and the openDAW device panel. Rows of effects, a pattern grid where drawn
blocks switch an effect on for their span. Inspired by the row-and-block idea of audiotool's Rasselbock, not a clone.

## Layout (176px high, 236px wide, all text 9px, studio capitalisation)

1. **Sequence strip** 14px on top. Left: A to D picks the pattern to edit. Right: 8 slots, the pattern sequence, a click
   cycles A, B, C, D, off. The playing slot is marked.
2. **Label column** 40px, effect name. Click selects the row, drag moves it (the order is the signal order, saved
   from state version 2 on). Nothing flashes while playing.
3. **Grid** 32 columns x 6px = 192px. The 32 columns always span the whole pattern, the Length setting maps them to
   1, 2 or 4 bars (so a column is a 1/32, 1/16 or 1/8 note).
4. **Rows** 12 x 12px = 144px, no scrolling.
5. **Bottom bar** 16px, one line of drag numerals: the selected row's two parameters, then the selected block's Prob
   and Ramp, or Length and Dice while no block is selected (clicking a label deselects). Four cells of equal width,
   name left, value right, values without units (percent implied). Mix is a host parameter only.
6. Playhead as a thin vertical line over the grid, dimmed while another pattern plays.

## Effects (initial order, top to bottom = signal order)

1. **Stutter** repeats the slice at block start. Params: division, decay (each repeat quieter or shorter).
2. **Shuffle** plays a different slice of the last bar. Params: slice size, seed.
3. **Reverse** plays the block backwards from its end. Params: size, crossfade.
4. **Scratch** vinyl back and forth over the block start. Params: rate, depth.
5. **Freeze** holds a grain cloud of the block start. Params: size, jitter.
6. **Tape** slows to a halt (stop) or spins up from zero (start) over the block. Params: mode, curve.
7. **Pitch** shifts down (or up) in a jump or glide. Params: semitones, glide.
8. **Crush** bit depth and sample rate reduction. Params: bits, rate.
9. **Filter** resonant filter sweeping over the block. Params: dir (sweep direction), resonance.
10. **Gate** rhythmic gate inside the block. Params: division, duty.
11. **Pan** auto pan. Params: rate, width.
12. **Throw** sends the block into a synced echo whose tail outlives the block. Params: time, feedback.

Dropped to fit 12px rows: Comb, Ring, Duck.

Effects 1 to 7 read from one shared input history (20 s), so several time effects stacked on one span follow the
signal order (the lower row wins) and do not each keep a copy. No per-row on/off: a row without blocks is off.

## Blocks

1. Drawn by dragging on a row, start and length snap to columns, blocks on a row never overlap.
2. **Prob** 0 to 100%: rolled once per pass, so a pattern varies every loop.
3. **Ramp** fades the effect in and out over the block (depth for tone effects, mix for time effects), no clicks.
4. **Dice** writes a random pattern for the current pattern slot, density from the Dice numeral.

## Patterns

Four patterns A to D, empty on a new device, played by a sequence of 8 slots that follows the host transport. Each
slot holds a pattern or off (dry). No MIDI input yet. A block that starts while the previous one of its row still
sounds crossfades from it in 5 ms (no click where patterns meet).

## Limits needing approval

1. 12 rows (one per effect), 4 patterns, 8 sequence slots, 32 columns per pattern.
2. 20 s of shared input history (a 4 bar block at 48 bpm still finds its start), 4 s of Throw echo.

## Phases

1. **Phase 0** layout preview, blue blocks chosen. Done.
2. **Phase 1** plugin in opendaw-commons/wclaps/glitchfest (C++ like Xenon), pattern state, transport sync,
   pattern sequence. Done.
3. **Phase 2** all twelve effects, Prob, Ramp. Done.
4. **Phase 3** page: grid drawing, block move, cells, Dice, playhead, open-webclap site entry and
   scripts/build-glitchfest.sh. Done, browser check open.
5. **Phase 4** openDAW bridge tests against test/assets/glitchfest.wasm (29 cases). Done, studio check open.
