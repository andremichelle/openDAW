# Groove Imprint

A groove taken from played material. The notes of a note region, or the transients of an audio region, are
quantised to 1/16 in memory. The distance from each grid point to where the event really sits becomes that grid
point's offset. Applied elsewhere, the groove shifts events by these offsets. Events between two grid points move by
the offset linearly interpolated between them. Timing only, velocity and duration stay as they are.

Working name "Imprint", like Groove DNA in Digital Performer but our own.

## Groove model

1. An Imprint is a cell groove like the others (`plans/zeitgeist-grooves.md`). Its duration is the length it was taken
   from, for example 1 bar.
2. It holds one offset per 1/16 of the cell, in pulses. Offset `k` moves grid point `k * 240` to `k * 240 + offset`.
3. Warp is the piecewise linear function through `(k * 240, k * 240 + offset_k)` and `(cell, cell)`. Between the
   points it interpolates linearly, which is the shift interpolation above. Unwarp is the same function inverted.
4. Every function must rise. A point that would reach its neighbour is clamped just before it when the offsets are
   taken, so the function stays monotonic and every amount stays valid.
5. Amount blends like the other grooves: 50% straight, 100% the imprint, below 50% its inverse. Default 100%.
6. It can be stacked and shared like every groove.

## Taking an imprint

1. **Note region:** context menu "Extract Groove". Every note start is quantised to the nearest 1/16 in content time.
   The offsets of all notes on the same grid point within the cell are averaged over every cell the region covers.
2. **Audio region (Pitch, Grain, Signalsmith):** the same with the transient markers, mapped to content pulses through
   the warp markers. No Sync audio has no musical grid and takes no imprint.
3. A grid point without an event takes the offset interpolated between its neighbours that have one, so a missing
   hat does not pull the others straight.
4. Offsets reach at most half a 1/16 (120 pulses). An event played further off lands on the neighbouring grid point,
   which is the limit of quantising to the nearest 1/16.
5. The new groove joins the groove list with the region's name and opens in the Grooves list. The source region keeps
   its own groove, so an imprint taken from a grooved region measures the played events, not the straight ones.

## Engine

1. `groove_registry.rs` reads the offsets and evaluates the piecewise linear warp and unwarp. Grid for Grain cuts:
   every 1/16.
2. Nothing else changes, every target already plays any groove through the registry.

## UI

1. The groove editor shows the offsets as a curve of bars, one per 1/16, like Random shows its steps.
2. Editing single offsets by drag is a later step.

## Tests

1. A region played with a known shuffle yields offsets that reproduce the shuffle within one pulse.
2. Applying the imprint to straight notes moves them onto the played positions, notes between grid points move by the
   interpolated offset.
3. Clamping keeps the warp monotonic for offsets that would cross.
4. TS and Rust warp agree (same table on both sides).
5. Audio: transients through warp markers at another tempo give the same offsets.

## Open

1. Name.
2. Storage: a fixed array field caps the cell (64 offsets is 4 bars). A list of child boxes has no cap.
