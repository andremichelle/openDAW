# Timeline Layout: Visual Grouping

## Problem

All tracks of an audio-unit share only an adjacent left border. That is the sole visual clue connecting them. We want clear grouping in the track-header column.

## Sorting (automatic)

Hierarchy, top to bottom:

1. **Audio-units** — sorted by their index, re-sortable by the user.
2. **Groups within a unit** (fixed order, mirrors the device panel):
   1. Instrument tracks (note or audio)
   2. MIDI FX automation
   3. Instrument automation
   4. Audio FX automation
3. **Devices within the FX groups** — same order as in the device panel (device `index` field). All automation tracks of one device stay together as a device group.
4. **Tracks within a device group** — sorted by their track index.

The user can re-order tracks only within their device group. Audio-units re-order freely at the top level.

```
├━ AUDIO-UNIT 0 "Vaporisateur"
│  ├─ instrument tracks
│  │    ├─ notes                 index 0
│  │    └─ notes                 index 1
│  ├─ MIDI FX automation
│  │    └─ Arp        rate
│  ├─ instrument automation
│  │    └─ Vapo       cutoff
│  └─ Audio FX automation
│       ├─ Delay      feedback   device 0
│       ├─ Delay      wet        device 0
│       └─ Revamp     lowBell    device 1
├━ AUDIO-UNIT 1 "Playfield"
│  ...
```

## Header display (dedup)

Per track the header shows: type icon, device name, target/track name. A value is NOT repeated when the
predecessor track (within the same unit) shows the same value — first occurrence wins, followers stay blank
in that column. Types: 🔊 audio, 🎹 notes, 📈 automation.

```
├━ AUDIO-UNIT "Vaporisateur"
│  ┌──────────────────────────────────┐
│  │ 🎹  Vaporisateur   Notes         │  ← first: icon + device + label
│  │                                  │  ← identical (icon+device+label) → blank row
│  │                                  │
│  │ 📈  Arp            rate          │  ← icon changes → shown once
│  │     Vaporisateur   cutoff        │  ← icon same → blank; device new
│  │                    vibrato       │  ← icon + device same → param only
│  │     Delay          feedback      │
│  │                    wet           │
│  │     Revamp         lowBell gain  │
│  └──────────────────────────────────┘
├━ AUDIO-UNIT "Tape"
│  ┌──────────────────────────────────┐
│  │ 🔊  Tape           Audio         │
│  │                                  │  ← second audio track: all identical → blank
│  │ 📈  Fold           drive         │
│  └──────────────────────────────────┘
```

Dedup is per column, independently: the icon dedups against the predecessor's type, the device name against
the predecessor's device, the label against the predecessor's label. Automation tracks always differ by their
parameter label; note/audio siblings are fully identical and collapse to blank rows. Dedup resets at every
unit boundary — the first track of a unit always shows everything.

## Status quo

`TracksManager#toSortedTrackScopes` already sorts `[unit.index, trackCategoryRank, track.index]`, but `trackCategoryRank` ranks instrument automation (1) before MIDI FX (2) — the reverse of the device panel. It also has no device-level ordering: two devices' automation tracks interleave by raw track index.

## Steps

1. Fix `trackCategoryRank` order: instrument tracks 0, MIDI FX 1, instrument 2, Audio FX 3.
2. Extend the sort with a device index PATH between category and track index: `[unit.index, categoryRank,
   devicePath..., track.index]`. The path is the index chain from the unit's chain down through nested
   composites (FX Composite cells, Playfield slots): composite index, cell/slot index, inner device index,
   recursively — compared lexicographically, so nested-device automation sorts right after its composite's own.
3. Header dedup: hide icon / device name / label when the predecessor track shows the same value (extends
   the existing `repeats-device` mechanism in `TracksManager#refreshNameDedup` to all three columns).
4. Visual grouping clues in the header column (to be designed).
5. Constrain user drag re-ordering of tracks to the same device group.
