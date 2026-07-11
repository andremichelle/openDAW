# Can we get Playfield like controls over the sample for the Tape Device? (#174)

**Doability:** ⭐⭐ (2/5). The two devices solve different problems (region/warp playback vs. note-triggered one-shot playback), the request as literally stated doesn't map cleanly onto Tape's current architecture, needs a maintainer decision on which device actually gets the feature.
**Type:** feature
**Scope:** medium, pending scope clarification

## What is asked

Reporter wants Start/End sample controls on the Tape device (to cut up and reverse samples), like Playfield has, and possibly a mono/poly voice "self-cutting" option. They note Playfield already gives this kind of control but "loses midi-note pitch" in the process.

## Current behaviour / relevant code

Investigated Tape's actual architecture, and it is **not a note-triggered instrument** despite being tagged `deviceType: "instrument"`:

`packages/studio/boxes/src/TapeDeviceBox.ts` Tags (line 90-94): `deviceType: "instrument", content: "audio"`. Its fields are only `flutter`/`wow`/`noise`/`saturation` (tape-coloring effects), nothing about a sample, start/end, or pitch.

`packages/studio/core-processors/src/devices/instruments/TapeDeviceProcessor.ts` confirms it: `get noteEventTarget(): Option<NoteEventTarget & DeviceProcessor> {return Option.None}` (it explicitly does not accept MIDI note events). It instead iterates the audio-unit's **audio tracks** (`this.#adapter.deviceHost().audioUnitBoxAdapter().tracks`) and, per lane, walks **audio regions/clips already placed on the timeline** (`#processBlock`, lines 104-200), applying tape coloring plus either transient-based time-stretch (`#processPassTimestretch`) or pitch-tracked playback (`#processPassPitch`) driven by the region's own warp markers / play-mode settings (`region.asPlayModeTimeStretch`, `adapter.asPlayModePitchStretch`, see `packages/studio/core-processors/src/devices/instruments/Tape/README.md` for the full time-stretch state machine). The chromatic pitch-tracking the reporter is missing on Playfield is already present here, but it comes from **warp markers on a placed audio region**, not from a start/end-trim + MIDI-note-triggered one-shot model.

Playfield, by contrast, is genuinely MIDI-note-triggered: `PlayfieldSequencer.handleEvent` uses the incoming note's pitch as a **pad index** (`this.#device.optSampleProcessor(event.pitch)`, `packages/studio/core-processors/src/devices/instruments/Playfield/PlayfieldSequencer.ts:45-48`), so a note doesn't transpose the sample, it selects which one of 128 possible pads plays at a fixed pitch (only fine-tuned by the pad's own `pitch` field, cents only). That is precisely the "loses midi-note pitch" complaint: Playfield's start/end/reverse controls (`packages/studio/core-processors/src/devices/instruments/Playfield/SampleVoice.ts`) exist, but the instrument they live on is architecturally a drum rack, not a chromatic sampler.

## Plan

This needs a scope decision before implementation, present both options to the maintainer:

**Option A — this is really about Nano, not Tape.** If what's wanted is "a chromatically-played, MIDI-note-triggered instrument with start/end trim and reverse, without losing per-note pitch," that is exactly the Nano sampler enhancement in #85 (`085-nano-sampler-playfield.md`), which already inherits Playfield's `sampleStart`/`sampleEnd`/reverse-via-negative-distance logic, and Nano is note-triggered so it naturally tracks MIDI pitch per voice rather than per pad-index. This resolves the "loses midi-note pitch" complaint directly, because Nano's voice model isn't index-locked the way Playfield's is. Recommend this as the actual fix and closing #174 as a duplicate of #85's scope, or retitling it.

**Option B — this is genuinely about the Tape device's region/warp workflow**, i.e. wanting an easier in-device way to trim/reverse the underlying audio region's playback window without going through the arranger's region-trim and warp-marker UI. If so:
1. Add start/end (and reverse-via-swap) fields to the relevant audio content adapter used by Tape's pitch path (`AudioContentBoxAdapter` / `AudioRegionBoxAdapter` / `AudioClipBoxAdapter`, referenced in `TapeDeviceProcessor.ts:205` and around), exposed as a device-level control rather than only via region boundary dragging in the timeline.
2. `Voice Mono/Poly self-cutting` would need Tape's `Lane`/`pitchVoices` structure (`TapeDeviceProcessor.ts:24-29`, currently one `SortedSet<UUID.Bytes, PitchVoice>` per lane, one voice per source region) to gain a "cut previous voice on new trigger" mode, but there is no MIDI-note trigger concept here at all today, this would need Tape to start accepting note events, a much bigger change than it sounds since `noteEventTarget` currently returns `Option.None` explicitly and the entire processor is timeline/region-driven, not event-driven.
3. This option is materially larger and changes what kind of device Tape is (adds an event-driven mode alongside its existing timeline-driven mode).

## Risks / open questions

- **The core risk is scope ambiguity**: the issue conflates two different mental models (Playfield's note-triggered drum rack vs. Tape's timeline/region-driven warp player). Get the maintainer to confirm which behaviour is actually wanted before writing any schema. Don't build Option B speculatively if Option A (already covered by #85) satisfies the actual complaint.
- If Option B is chosen, adding note-event acceptance to a processor that explicitly opts out today (`Option.None`) is a structural change with time-stretch/warp-marker interactions that need careful design, this is not a small addition.
- Cross-reference #85 and #288 before starting, this issue may simply close once #85 ships if that turns out to be what the reporter meant.
