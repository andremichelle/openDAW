# Request - Instrument/FX Layer device (#141)

**Doability:** ⭐ (1/5). Requires a new nested-device-graph container, the current track/device-host model is fundamentally one-instrument-per-track.
**Type:** feature
**Scope:** large

## What is asked

An Ableton/Bitwig-style Instrument/FX rack: layer multiple independent fx chains (or instrument+fx chains) in parallel on the same track, with split processing by key/velocity/note-range, and macro controls exposed at the rack level.

## Current behaviour / relevant code

The audio-unit (track) model is strictly **one instrument slot + one linear MIDI-effect chain + one linear audio-effect chain** per track. See `DeviceHost` interface, `packages/studio/adapters/src/DeviceAdapter.ts:57-72`:

```
export interface DeviceHost extends BoxAdapter, LabeledAudioOutputsOwner {
    get midiEffects(): IndexedBoxAdapterCollection<MidiEffectDeviceAdapter, Pointers.MIDIEffectHost>
    get inputAdapter(): Option<AudioUnitInputAdapter>
    get audioEffects(): IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost>
    ...
}
```

One `AudioUnitBoxAdapter` (`packages/studio/adapters/src/audio-unit/AudioUnitBoxAdapter.ts`) owns exactly one of each collection. There is no existing concept of parallel chains summed together inside one track, and no per-note/velocity/key-range split-routing concept anywhere in the instrument or MIDI-effect pipeline.

The closest existing precedent for "a device that contains a sub-graph" is the **Modular device** (`packages/studio/boxes/src/ModularDeviceBox.ts`, `packages/studio/adapters/src/modular/modular.ts`): it is one device slot that owns its own internal collection of modules and connections (`ModularBox` fields `modules`/`connections`, `packages/studio/boxes/src/ModularBox.ts:89-93`), fully separate from the track's own device chains. That is the right shape to imitate for a rack container (one device slot, an internal collection of "layers"), but Modular's internal graph is an audio-signal patch graph (gain/delay/multiplier), not instrument+fx chains, and it has no note-routing/velocity-split concept either.

MIDI note events already carry velocity and pitch per `NoteEvent` (used throughout, e.g. `packages/studio/core-processors/src/devices/instruments/VaporisateurVoice.ts`), so per-note-value split conditions are computable, but there is no existing "note filter" device or gate to mirror.

## Plan

1. **Model the container as a new device slot type**, analogous to Modular: one `InstrumentRackDeviceBox` (or similar) occupying an instrument-host slot, owning an internal collection of **layers**. Each layer is its own `DeviceHost`-shaped chain: an instrument-or-passthrough + MIDI-effect chain + audio-effect chain, mirroring the existing per-track pattern but nested. Reuse `IndexedBoxAdapterCollection` for each layer's internal chains rather than inventing a new collection type.
2. **Split conditions per layer** — a filter box on each layer's MIDI input: key range (min/max note), velocity range (min/max), and optionally a note-name allowlist. This is new — there is no existing note-filter device to mirror. Keep it simple: a range gate that drops `NoteEvent`s outside the configured bounds before they reach the layer's instrument.
3. **Parallel audio summation** — each layer's audio output sums into the rack's single output, same pattern as how `MixProcessor` sums Playfield pad outputs today (`packages/studio/core-processors/src/devices/instruments/Playfield/MixProcessor.ts`) — a reasonable processor-level template for "many parallel voices/chains summed to one output."
4. **Macros** — N macro knobs at the rack level, each one a modulation-style fan-out to one or more parameters across the nested layers. This needs the same "assign this control to any parameter" plumbing as #139's modulation-routing ask (a macro is really a one-source, many-target modulation router with a depth per target) — if #139's Phase 1 infra lands first, macros should be built on top of it rather than as a separate bespoke mechanism.
5. **UI** — a rack view listing layers (mirror the Modular tab/list UI shape in `packages/app/studio/src/ui/modular/ModularView.tsx` for the "container device with an internal list of sub-things" interaction pattern), each layer showing its key/velocity range as a small keyboard-range widget (no existing widget to mirror, new UI).

## Risks / open questions

- This is a structural change to how many devices can be nested inside one track slot. Before designing the box schema, confirm with the maintainer whether layers should be able to contain **full instruments** (a Vaporisateur inside a rack layer) or only **audio effects on the track's existing instrument output** (closer to a "parallel fx splitter", much smaller scope). The issue title says "Instrument/FX Layer" implying full nested instruments, which is the harder version.
- Key/velocity/note-range split filtering does not exist anywhere in the codebase today and has to be designed from scratch (no MIDI-effect precedent filters by range currently, confirm by checking existing MIDI effects before assuming).
- Macro controls overlap heavily with #139 (parameter-modulation infra). Recommend sequencing this after #139's Phase 1 lands, or scoping macros out of a v1 rack device entirely (ship layering + splits first, add macros once generic routing exists).
- Nested `IndexedBoxAdapterCollection` inside a device (rather than inside an `AudioUnitBoxAdapter`) is architecturally new — verify the collection type doesn't assume it's always parented by an audio-unit box before reusing it.
