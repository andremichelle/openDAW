# Time-base: seconds vs ppqn

STATUS 2026-09-21: sections 5.1 (box-level reader) and the load-check move are DROPPED. The overlap rule never
needs a conversion (a seconds region is skipped, a musical one is already ppqn), so one box-level check
`RegionOverlap` in studio-adapters serves all sites. Done, uncommitted: 3.1, the exporter of 3.2, 5.2. The engine
already cuts a seconds region at its successor (`crates/value/tests/region.rs`). Still open: constant-bpm
migrations (3.2), `loopOffset` unit (3.3), single `time-base` writer (5.4), float64 (5.6), raw-read guard test.

Analysis after live 1140. Scope: how openDAW stores, converts and compares time values that can be either
musical (ppqn) or absolute (seconds), what other DAWs do, and a design that closes the whole defect class
instead of one creator at a time.

## 1. The one fact everything follows from

A position can be converted between domains. A duration cannot, unless you also say where it starts.

"7.5 seconds" is 14400 ppqn at 120 bpm and 15360 ppqn at 128 bpm. With tempo automation it also depends on
where the span sits. So for a seconds region, `complete` in ppqn is not a stored fact. It is a function of
(duration, position, tempo map). It changes when any of the three changes, including when nobody touched the
region.

In openDAW only ONE edge of ONE kind of region floats: the END of a SECONDS audio region. Every position is
int32 ppqn. Every musical duration is fixed ppqn. That is a small surface, and it is the entire problem.

Any rule that says "this floating end must not pass the next region" is a rule about derived state. It can be
broken by three events, and only one of them is an edit of the region:

1. the region moves (handled: the resolver uses `resolveComplete(position)`)
2. the time-base flips seconds to musical (1140, the exemption disappears in the same write)
3. the tempo map changes (not handled at all, and cannot be "handled" without destroying neighbours)

## 2. What we have today

Storage, `AudioRegionBox` schema:

- `position` int32 ppqn
- `duration`, `loop-offset`, `loop-duration` float32, `unit: "mixed"`, meaning decided by the string field `time-base`
- `waveform-offset` float32 seconds

Conversion lives in one good place: `TimeBaseConverter` (`lib/dsp/src/time-base.ts`). `toPPQN(position)` takes the
origin and integrates through the tempo map. The Rust engine mirrors it (`seconds_span_to_ppqn(position, value)`
in `audio_unit/tracks/audio.rs`). This core is correct and matches what Ardour and Tracktion do (section 4).

The problems are all AROUND that core: code that reads the mixed fields without going through it.

## 3. Defects found in this survey

### 3.1 Six overlap predicates, five different semantics

| site | reads | seconds handling | tolerance |
|---|---|---|---|
| `RegionClipResolver.validateTrack` | adapter ppqn | prev exempt | float32 ulp |
| `ProjectValidation.validate` (load, DELETES both regions) | raw field | none, seconds read as ppqn | none |
| `Project.invalid()` | raw field | `return false` on first seconds region | none |
| `Validator.hasOverlappingRegions` | raw field, copy of the above | same | none |
| `ProjectApi` track merge `fits` | raw field | none | none |
| `RegionPushExistingResolver.#hasSpace` | raw field via `as any` | none | none |

Consequences:

- `ProjectValidation` reads a 26 s region as "26 ppqn long". A stacked seconds region therefore always passes the
  load check. The reverse also exists: a seconds region at position 0 followed by a region at ppqn 20 is flagged
  and both are deleted, although nothing overlaps.
- `Project.invalid()` and `Validator` use `return false` where `continue` is meant. One seconds region anywhere
  on a track switches the check off for every later pair on that track.
- `fits` and `#hasSpace` believe a seconds region occupies a few ppqn, so they will place a region on top of it.

### 3.2 Raw reads that are simply wrong for seconds regions

- `DawProjectExporter` audio clips: `region.duration.getValue() / PPQN.Quarter` with `contentTimeUnit: BEATS`.
  A 30 s not-stretched region exports as 0.03 beats.
- `MigrateAudioRegionOverlaps`, `MigrateZeroDurationRegions`: convert with ONE bpm constant, not the tempo map.
  Wrong for any project with tempo automation.

### 3.3 `loopOffset` has no defined unit on a seconds region

- schema says mixed
- `MigrateAudioRegionBox` (AudioFit) writes SECONDS
- `switchTimeBaseToMusical` `some` branch scales it as SECONDS, the `none` branch copies it RAW
- `AudioRegionBoxAdapter.loopOffset` returns it raw typed as `ppqn`, `offset` subtracts it from a ppqn position,
  the setter does `mod(value, loopDuration-in-ppqn)`
- the Rust engine reads it raw as ppqn

It works because in practice it is always 0 on a seconds region (`switchTimeBaseToSeconds` zeroes it and
`moveContentStart` uses `waveformOffset` instead). That is an unwritten invariant holding a unit conflict shut.

### 3.4 Time-base switch is a domain change with no domain-change protocol

`switchTimeBaseToMusical` rewrites three fields and flips the flag. Nothing revalidates the track. 1140 fixed the
missing clamp, but the structure is still "remember to do the right thing in every branch".

### 3.5 Tempo changes

A tempo edit or tempo automation moves every seconds region's end. No code reacts. With the prev-only exemption
this is legal by definition, which is the right call, but section 3.1 shows half the codebase does not know the
exemption exists.

### 3.6 Precision

float32 seconds has an ulp of about 6e-5 s at 10 minutes, roughly 3 samples at 48 kHz. int32 position against a
fractional derived end already needed `boundaryTolerance`, `migrateAudioRegionOverlaps` and the `secondsWithin`
ulp-stepping loop. These are all symptoms of comparing a derived float against a stored integer.

### 3.7 The type system cannot see any of this

`ppqn` and `seconds` are both aliases of `number`. Every bug above compiles.

## 4. How other DAWs solve it

### Ardour (`libs/temporal`, read from source for this analysis)

The most complete answer to this exact problem, because Ardour 7 was a multi-year rewrite caused by it.

- `timepos_t`: one 62-bit integer plus a flag bit for the domain (`is_beats()` / `is_superclock()`). A position
  always knows its domain. There is no "mixed number".
- `timecnt_t`: a distance that CARRIES ITS ORIGIN (`_distance` + `_position`, "aka origin"). The header states the
  reason: "3 beats" as a distance always means "3 beats after <position>". Distance and origin may be in different
  domains. Conversion goes through the tempo map using that origin.
- All integer. Audio time is "superclock" ticks (default 282240000 per second, divisible by every common sample
  rate), beats are 1920 ticks per quarter. No float appears in any timeline comparison.
- Regions have a time domain. A tempo map change runs a "domain bounce" so audio-time objects keep their audio
  position while beat-time objects keep their beat position.
- Overlap is not an error. Regions are layered and the top layer is heard. There is no invariant to break.

### Tracktion Engine (`tracktion_core/utilities/tracktion_Time.h`, `tracktion_Tempo.h`, read from source)

- Four distinct types: `TimePosition`, `TimeDuration`, `BeatPosition`, `BeatDuration`. Mixing them does not compile.
- `tempo::Sequence` offers `toBeats(TimePosition)`, `toTime(BeatPosition)` and the RANGE versions
  `toBeats(TimeRange)`, `toTime(BeatRange)`. I grepped for a duration conversion: there is none. You cannot
  convert a bare duration, by construction. Same insight as Ardour's origin, enforced by omission.
- Clips store seconds. `Clip::SyncType { syncBarsBeats, syncAbsolute }` decides what a tempo change does: beat-synced
  clips are re-written to keep their beat position, absolute ones stay. The floating edge is resolved at the
  moment the tempo changes, by policy, not discovered later by a validator.

### LMMS (`SampleClip.cpp`, read from source)

Everything is ticks. A sample clip listens to `Song::tempoChanged` and calls `updateLength()`, rewriting its tick
length from the sample length. Simple, but only correct with a single global tempo, and it overwrites user trims.
This is the model to avoid.

### Audacity, Reaper, Zrythm (from memory, not re-read for this analysis)

- Audacity: the timeline is seconds (double). Clips carry a raw tempo and the project tempo, stretch ratio is
  derived. Musical time is a view over seconds.
- Reaper (closed source, documented behaviour): per-item timebase with three explicit modes, "time", "beats
  (position, length, rate)" and "beats (position only)". The third mode is exactly openDAW's seconds region: beat
  anchored start, time-length body. Overlap is allowed and handled by lanes and auto-crossfade.
- Zrythm v1 stored BOTH ticks and frames in every `Position` and refreshed the other one on tempo change. The cache
  went stale in exactly the ways one would expect, and v2 moved to a single stored domain plus conversion.

### What they agree on

1. A value knows its domain. No bare numbers whose unit lives in a sibling field.
2. A duration converts only together with its origin.
3. Store ONE domain per value. Derive the other. Never cache both in the document.
4. Integer or double time. Nobody uses float32.
5. Nobody enforces "no overlap" as a crash-level invariant on a tempo-dependent edge. It is either layering
   (Ardour, Reaper) or resolved by policy at the moment of the domain or tempo change (Tracktion).

openDAW already follows 2 and 3 in its core. It breaks 1, 4 and 5.

## 5. Proposed design

### 5.1 One reader for the mixed fields, at BOX level

New `AudioRegionTime` (studio-adapters, next to the adapter, no adapter instance needed):

```ts
AudioRegionTime.span(box: AudioRegionBox, tempoMap: TempoMap): RegionSpan   // position, duration, complete, loopDuration in ppqn
AudioRegionTime.spanAt(box, tempoMap, position): RegionSpan                 // preview position, what resolveComplete does today
```

It wraps `TimeBaseConverter` and is the ONLY code allowed to call `.duration/.loopDuration/.loopOffset.getValue()`
on an `AudioRegionBox` or `AudioClipBox`. The adapter getters delegate to it. Box-level matters because
`ProjectValidation`, migrations, `fits` and `#hasSpace` run before adapters exist or mid-transaction where adapter
caches are stale.

Guard: a vitest "contract" test that greps the source tree for raw reads of those three fields outside an
allowlist (the reader, the schema, the engine sync). This is the cheap substitute for branded types. Branding
`ppqn` and `seconds` across the whole codebase would be the pure solution, and it is a change of several thousand
lines. Not recommended now. Recommended only for NEW signatures in this area.

### 5.2 One overlap predicate

`RegionOverlap.find(trackBox, tempoMap): Option<[prev, next]>` built on 5.1, with the exemption and the tolerance
inside it. All six sites in 3.1 call it. `validateTrack` keeps its panic and its dump. `ProjectValidation` keeps
its heal. They stop disagreeing about what an overlap is.

### 5.3 Make the rule explicit: a seconds region ends at its successor

Today the rule is implicit: "prev seconds is exempt". I recommend stating the positive version and implementing
it once:

    effectiveComplete(region) = min(complete(region), next.position)      for a seconds region
    effectiveComplete(region) = complete(region)                          for everything else

Used by rendering, hit-testing, the engine and every converter. Then:

- a tempo change can never create an invalid state, because there is no stored state to invalidate
- seconds to musical conversion writes `effectiveComplete - position`. That is `clampToGap` from the 1140 fix,
  derived from a rule instead of patched into a branch
- recorded takes and stacked drops get a defined sound (the later region wins) instead of whatever the engine
  happens to do with two live regions today. THIS PART IS A BEHAVIOUR CHANGE IN THE ENGINE and needs your call,
  see section 7

### 5.4 Domain change as one operation

`AudioRegionTime.switchTimeBase(adapter, target, spanPolicy)` is the only writer of `time-base`. It reads the
span in the old domain, flips, writes the span in the new domain through 5.3, and ends with `RegionOverlap.find`
on the track as a postcondition. `switchTimeBaseToMusical`/`ToSeconds`, the scripting `Regions.ts`/`Clips.ts`
writers and the two migrations route through it. A new creator then fails in its own transaction, in its own
test, not twelve minutes later in a loop-duration drag.

### 5.5 Pin the `loopOffset` unit

Decide: on a seconds region `loopOffset` is always 0 and `waveformOffset` carries the content start. Enforce in
5.4 and assert in the reader. Add a load migration that folds a non-zero seconds `loopOffset` into
`waveformOffset`. Update the schema comment and the `// WASM CONTRACT:` marker on the Rust side.

### 5.6 Precision

The box schema has no float64. Two options:

- add `float64` to lib-box and move `duration`, `loop-duration`, `loop-offset`, `waveform-offset` over with a
  migration. Removes `boundaryTolerance`-class workarounds at the source. Touches the wasm sync codec
- keep float32 and accept about 3 samples of slop at 10 minutes

Recommendation: do it, but last and separately. It is the only item here that touches the file format and the
engine codec.

## 6. Order of work

Each step is green on its own and none changes behaviour for a valid project.

1. `AudioRegionTime` reader + adapter delegates to it. Pure refactor. Parity test against the current adapter
   getters over a tempo-automated project.
2. `RegionOverlap.find` + switch the six sites. Tests: every row of 3.1 as a failing case first (false delete on
   load, `return false` short-circuit, `fits` stacking onto a seconds region).
3. Fix the exporter and the two constant-bpm migrations through the reader.
4. `switchTimeBase` single writer with postcondition. The four 1140 tests move under it unchanged.
5. `loopOffset` invariant + migration + contract marker.
6. Raw-read guard test. From here the class cannot silently come back.
7. Section 5.3 engine semantics, after your decision.
8. float64, separately.

Test matrix that every step runs against: {musical, seconds} x {constant tempo, tempo ramp across the region} x
{neighbour touching, 1 ppqn gap, overlapping, same position} x {move, resize, switch base, tempo edit, save and
reload}.

## 7. Decisions I need from you

1. Section 5.3: should the later region cut a seconds region at playback (Reaper/Ardour style "later wins"), or
   do stacked seconds regions keep sounding together as they do now? The UI and converters can adopt
   `effectiveComplete` either way. Only the engine part is a behaviour change.
2. Section 5.6: is a `float64` field type in lib-box acceptable?
3. `ProjectValidation` currently deletes BOTH regions of an overlapping pair on load. With a correct predicate it
   will start seeing real overlaps it was blind to. Trim prev to the gap (what `migrateAudioRegionOverlaps` does
   for slivers) loses nothing. I recommend switching the heal from delete to trim in step 2.
