# Tape Playback System Architecture

This document captures all architectural decisions for the tape-based audio playback system in openDAW.

---

## CURRENT STATUS: REDESIGN IN PROGRESS

We are rebuilding the playback system from scratch with clean separation of concerns.

### Key Terminology

| Term | Definition |
|------|------------|
| **playback-speed** | Overall speed in BPM (tempo) |
| **playback-rate** | How fast we play a transient (1.0 = original pitch, 2.0 = octave up) |
| **time-stretch** | Transient-based granular playback (transient after transient) |
| **pitch-stretch** | Playback rate adjustment to reach warp markers (continuous) |

### Core Design Principles

1. **No auto-fade-out in voices** - Voices never decide when to fade out
2. **Sequencer controls everything** - All start/stop decisions come from sequencer
3. **Sample-exact timing** - All operations use block offsets for sample accuracy
4. **Clean separation** - Separate sequencers for pitch-stretch and time-stretch
5. **Transparency at 100%** - At matching BPM (playback-rate = 1.0), output = original sample

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                  TapeDeviceProcessor                     │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─────────────────────┐    ┌─────────────────────────┐ │
│  │  PitchStretchSeq    │    │   TimeStretchSequencer  │ │
│  │  (warp markers)     │    │   (transient-based)     │ │
│  └─────────────────────┘    └─────────────────────────┘ │
│           │                            │                 │
│           ▼                            ▼                 │
│    ┌─────────────┐            ┌─────────────────────┐   │
│    │ PitchVoice  │            │ OnceVoice           │   │
│    └─────────────┘            │ RepeatVoice         │   │
│                               │ PingpongVoice       │   │
│                               └─────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Focus: Time-Stretch Sequencer

The time-stretch sequencer is responsible for:
1. Tracking current transient index
2. Calculating when to spawn new voices (sample-exact)
3. Calculating when to fade out voices (sample-exact)
4. Handling tempo changes
5. Handling discontinuities (loop jumps, seeks)

### OnceVoice Challenge

OnceVoice is the most complex because:
- It must NOT fade out early if the next transient falls within its "budget"
- Budget = the audio samples available in the current transient segment
- Only when timeline time exceeds the budget should it fade out
- At 100% playback-rate, the voice should naturally end exactly when next transient starts

---

## Changelog

### 2025-12-08 - Redesign Decision

**Problem**: The current implementation has accumulated features and symptom fixes, resulting in unreadable code with tangled responsibilities.

**Decision**: Start from scratch with clean separation of concerns:
- Voices become "dumb" - they only play audio with fade-in/fade-out on command
- Sequencers become "smart" - they control all timing decisions
- Separate files for pitch-stretch and time-stretch sequencing

**Focus**: Time-stretch first (most complex, 3 voice types)

---

## RESOLVED DECISIONS

### D1: Transparency
**Perceptually identical** at 100% - crossfades are always acceptable. No need for bit-identical passthrough mode.

### D2: OnceVoice Budget Exhaustion
When playback-rate > 1.0 and voice runs out of audio before next transient: **Silence**. Voice ends, output is silent until next transient starts.

### D3: Crossfade at Transient Boundaries
**Always crossfade** - Old voice fades out, new voice fades in. Simpler logic, fewer edge cases.

### D4: Discontinuity Handling
**Never allow clicks**. On any discontinuity (loop jump, seek, tempo change): fade out current voices, then start fresh. No hard stops ever.

### D5: Time Units
**All durations in seconds**, not samples. The engine may run at different sample rates. Convert to samples only at the final rendering step.

### D6: Fade Constants (in seconds)
Two separate fade durations:
- **VOICE_FADE_DURATION** - For voice start/stop crossfades (~5ms)
- **LOOP_FADE_DURATION** - For loop boundary crossfades in Repeat/Pingpong (~5ms)

Keep separate for now, can merge later if identical in practice.

### D7: No Minimum Loop Length
`LOOP_MIN_LENGTH_SAMPLES` is removed. Transient detection should ensure segments are always long enough to loop (>46ms). This is a constraint on the transient detector, not the playback system.

### D8: Loop Margins (in seconds)
Two separate margins to define the loopable region within a transient segment:
- **LOOP_MARGIN_START** - Skip the attack of the transient (don't repeat it)
- **LOOP_MARGIN_END** - Avoid bleeding into the next transient's material

```
Segment:    [=====ATTACK=====|-------LOOP REGION-------|==TAIL==]
            ^                ^                         ^        ^
         start        start + MARGIN_START    end - MARGIN_END  end
```

### D9: OnceVoice Playback Range
OnceVoice plays the **full segment** (start to end), no margins apply. Margins are only for Repeat/Pingpong looping.

### D10: Voice Fade-In Rule (All Voice Types)
Consistent across OnceVoice, RepeatVoice, PingpongVoice:
- **Position = 0** (start of audio file): No fade-in needed
- **Position > 0**: Fade-in required (we're cutting into existing audio)

Fade-out: Always controlled by sequencer.

### D11: Repeat/Pingpong Initial Playback
First iteration plays from `start` to `end - MARGIN_END` (attack + loop region, excluding tail). Then loops within margin region only.

```
Segment:     [ATTACK|----LOOP----|TAIL]
             ^      ^            ^    ^
           start  +MARGIN    -MARGIN  end

First play:  [ATTACK|----LOOP----]
             start →→→→→→→→→→→→→ end-MARGIN (then loop/bounce)

Loop:              [----LOOP----]
                   ^            ^
         start+MARGIN_START   end-MARGIN_END
```

RepeatVoice: crossfades from `end - MARGIN_END` back to `start + MARGIN_START`.
PingpongVoice: crossfades while reversing direction at `end - MARGIN_END` and `start + MARGIN_START` (hard reversal causes audible clicks).

### D12: playback-rate and Loop Boundaries
playback-rate only affects traversal speed through the audio. Loop/bounce boundaries are fixed sample positions in the audio file - they don't shift based on playback-rate.

### D13: Near-100% Playback-Speed Phasing Prevention
When playback-speed is close to 100%, voice N and voice N+1 would read nearly the same audio during crossfade, causing phase cancellation.

**Solution**: If the current voice's read position is within a threshold of the next transient's start position, **don't spawn a new voice** - let the current voice continue playing into the next segment.

**Threshold**: Fixed value in seconds (e.g., `DRIFT_THRESHOLD = 0.005` for ~5ms). New constant, separate from fade durations.

**Self-correcting behavior**: The position error accumulates over multiple transients. Eventually the drift exceeds the threshold, triggering a crossfade that resyncs the voice to the correct position. This naturally compensates for near-100% playback-speed drift.

```
Transient:    1      2      3      4      5      6
Drift:       +1ms   +2ms   +3ms   +4ms   +5ms   → exceeds threshold
Action:      cont   cont   cont   cont   cont   CROSSFADE (resync)
```

This avoids:
- Phase cancellation from overlapping near-identical audio
- Unnecessary voice spawning
- Complex special-case crossfade logic

**Note**: For Repeat/PingpongVoice, continuation only applies during the initial forward pass (before looping starts). Once looping, playback-speed is necessarily not near 100% (otherwise looping wouldn't be needed), so this scenario doesn't arise.

### D14: Available Infrastructure

**Block information** (from `processing.ts`):
```typescript
Block = {
    p0, p1: ppqn       // range in musical time
    s0, s1: int        // range in audio samples (buffer positions)
    bpm: number        // tempo in this block
    flags: int         // BlockFlag bits
}

BlockFlag = {
    transporting    // timeline is advancing
    discontinuous   // time jump (loop, seek) - NOT naturally advanced
    playing         // arrangement should generate sound
    tempoChanged    // tempo has changed
}
```

**Tempo conversions** (from `tempo.ts` via `TempoMap`):
- `ppqnToSeconds(position)` - musical time → absolute time
- `secondsToPPQN(time)` - absolute time → musical time
- `intervalToSeconds(fromPPQN, toPPQN)` - duration conversion
- `getTempoAt(ppqn)` - get BPM at position

**AudioWorklet scope**: `sampleRate` is globally available.

**Recomputation triggers** (from BlockFlags):
- `BlockFlag.tempoChanged` → recalculate timing
- `BlockFlag.discontinuous` → fade out, start fresh

### D15: Voice Type Selection
```
if TransientPlayMode == Once:
    use OnceVoice (may result in silence if audio exhausted before next transient)
else if TransientPlayMode == Repeat:
    use RepeatVoice
else if TransientPlayMode == Pingpong:
    use PingpongVoice
```

User choice is always respected. `looping_needed` calculation is only used for D13 (drift/continuation logic), not for voice type selection.

### D16: Voice States
Simplified to 3 states + direction:
- **Fading** - Voice is crossfading (direction: +1 = in, -1 = out)
- **Active** - Voice at full amplitude
- **Done** - Voice finished, remove from list

```typescript
enum VoiceState { Fading, Active, Done }
// fadeDirection: +1.0 (fading in) or -1.0 (fading out)
```

---

## OPEN QUESTIONS

*None currently - ready for next design phase.*

---

## Core Components (Legacy Reference)

### Voice Interface (`Voice.ts`)

```typescript
interface Voice {
    done(): boolean
    startFadeOut(blockOffset: int): void
    process(bufferStart: int, bufferCount: int): void
}
```

All voice implementations share this interface:
- `done()` - Returns true when voice has finished playback and can be removed
- `startFadeOut(blockOffset)` - Initiates fade-out starting at a specific sample offset within the current block
- `process(bufferStart, bufferCount)` - Renders audio samples to the output buffer

### Voice States (`VoiceState.ts`)

```typescript
enum VoiceState { Fading, FadingIn, Active, FadingOut, Done }
```

- `FadingIn` - Voice is ramping up amplitude from 0 to 1
- `Active` - Voice is at full amplitude
- `FadingOut` - Voice is ramping down amplitude from 1 to 0
- `Done` - Voice has completed and should be removed
- `Fading` - Bidirectional fade (used by PingpongVoice)

### Segment (`Segment.ts`)

```typescript
type Segment = { start: number, end: number } // in samples
```

Defines the sample range for voice playback.

### Constants (`constants.ts`)

```typescript
FADE_LENGTH = 256           // Samples for fade in/out crossfades
FADE_LENGTH_INVERSE = 1/256 // Precomputed for efficiency
LOOP_START_MARGIN = 256     // Samples to skip at loop start (avoid clicks)
LOOP_END_MARGIN = 256       // Samples to skip at loop end (avoid clicks)
LOOP_MIN_LENGTH_SAMPLES = 2048  // Minimum loop length to enable looping
```

## Voice Implementations

### 1. OnceVoice (`OnceVoice.ts`)

**Purpose**: Single-shot playback of a segment with fade-in/fade-out.

**Key Features**:
- Plays from `segment.start` to `segment.end` once
- Linear fade-in at start, linear fade-out at end or when `startFadeOut()` is called
- Supports variable `playbackRate` for pitch shifting
- Uses linear interpolation for sub-sample accuracy

**State Transitions**:
```
FadingIn -> Active -> FadingOut -> Done
```

**Fade-Out Behavior**:
- If called during `FadingIn`: Reverses from current amplitude level (smooth transition)
- If called during `Active`: Starts fresh fade-out from full amplitude
- `fadeOutBlockOffset` delays the start of fade-out to exact sample position

### 2. RepeatVoice (`RepeatVoice.ts`)

**Purpose**: Looping playback with forward-only crossfade at loop boundary.

**Key Features**:
- Loops between `loopStart` (segment.start + LOOP_START_MARGIN) and `loopEnd` (segment.end - LOOP_END_MARGIN)
- When approaching `loopEnd`, crossfades to `loopStart`
- Crossfade length = FADE_LENGTH (256 samples)
- Uses linear crossfade (not equal-power)

**Loop Crossfade Algorithm**:
1. When `readPosition >= loopCrossfadeStart` (loopEnd - FADE_LENGTH):
   - Start secondary read position at `loopStart`
   - Linear crossfade: `sample = main * (1 - t) + loop * t`
2. When crossfade completes, snap main position to loop position

### 3. PingpongVoice (`PingpongVoice.ts`)

**Purpose**: Bidirectional looping (forward then backward) with bounce crossfade.

**Key Features**:
- Bounces between `loopStart` and `loopEnd`
- Direction reverses at boundaries
- Uses equal-power crossfade (cos/sin) for smooth bounce

**Bounce Crossfade Algorithm**:
- Bounce fade length = 256 samples (separate from FADE_LENGTH)
- When approaching boundary:
  1. Start bounce position at the boundary
  2. Bounce position moves in opposite direction
  3. Equal-power crossfade: `fadeOut = cos(t * PI/2)`, `fadeIn = sin(t * PI/2)`
- After crossfade: main position = bounce position, direction flips

**State Machine**:
- Uses `Fading` state with `fadeDirection` (+1 or -1) for bidirectional amplitude control
- `direction` tracks playback direction (+1 forward, -1 backward)

### 4. PitchVoice (`PitchVoice.ts`)

**Purpose**: Simple pitch-shifted playback without looping.

**Key Features**:
- Adjustable `playbackRate` during playback via `setPlaybackRate()`
- Auto fade-out when approaching end of audio data
- `fadeOutThreshold = numberOfFrames - fadeLength * playbackRate`
- Tracks `readPosition` for drift detection

**Drift Detection** (in TapeDeviceProcessor):
- If voice's read position drifts > FADE_LENGTH samples from expected position, voice is faded out and replaced

## TapeDeviceProcessor

**Location**: `TapeDeviceProcessor.ts`

### Lane Management

Each track has a `Lane`:
```typescript
type Lane = {
    adapter: TrackBoxAdapter
    voices: Array<Voice>
    lastTransientIndex: int
}
```

### Processing Pipeline

1. **Per-block processing**: `process()` iterates all blocks for all lanes
2. **Clip sequencing**: Handles both regions and clips
3. **Two playback modes**:
   - **Pitch mode**: Simple playback rate adjustment (uses PitchVoice)
   - **Timestretch mode**: Transient-based granular (uses OnceVoice/RepeatVoice/PingpongVoice)

### Pitch Mode (`#processPassPitch`)

1. Calculate `playbackRate` from audio duration vs timeline duration
2. Calculate sample offset considering waveform offset
3. **With warp markers**: Use `#ppqnToSeconds` and `#getPlaybackRateFromWarp`
4. **Without warp markers**: Direct ratio calculation
5. Create/update PitchVoice via `#updateOrCreatePitchVoice`

**Drift handling**:
- If existing voice's position differs from expected by > FADE_LENGTH samples:
  - Fade out old voice
  - Create new voice at correct position

### Timestretch Mode (`#processPassTimestretch`)

1. **Transient tracking**: `lastTransientIndex` tracks which transient is currently playing
2. **Boundary detection**: Compare transient index at block end vs stored index
3. **Loop detection**: If index decreases, content has looped - reset and fade out
4. **Voice spawning**: On transient boundary crossing:
   - Calculate segment from current to next transient
   - Determine if looping is needed (based on time until next transient)
   - Choose voice type based on `TransientPlayMode`:
     - `Once`: OnceVoice
     - `Repeat`: RepeatVoice
     - `Pingpong`: PingpongVoice

**Loop Decision Logic**:
```typescript
canLoop = samplesNeeded > samplesAvailable * 1.01 && loopLength >= LOOP_MIN_LENGTH_SAMPLES
```
- Only loop if we need >1% more samples than available AND loop is long enough

### Warp Marker Utilities

**`#ppqnToSeconds(ppqn, normalizedFallback, warpMarkers)`**:
- Converts PPQN position to file seconds using linear interpolation between warp markers

**`#secondsToPpqn(seconds, warpMarkers)`**:
- Inverse of above - converts file seconds to PPQN

**`#getPlaybackRateFromWarp(ppqn, warpMarkers, sampleRate, pn, sn)`**:
- Calculates instantaneous playback rate at given PPQN position
- `audioSamplesPerPpqn / timelineSamplesPerPpqn`

### Block Offset Calculation

For sample-accurate transient triggering:
```typescript
const ppqnIntoBlock = transientPpqn - contentPpqn
const blockOffset = Math.max(0, Math.min(bpn - 1, ((ppqnIntoBlock / pn) * bpn) | 0))
```

## Critical Design Decisions

### 1. Crossfade Synchronization

When spawning a new voice and fading out the old:
- New voice starts at `fadeProgress = 0` (amplitude = 0)
- Old voice's `startFadeOut()` resets its `fadeProgress = 0` (starting fade from 1)
- This keeps both voices synchronized for perfect crossfade

**Exception**: If old voice is still fading in, calculate current amplitude and start fade-out from that level.

### 2. Block Offset Handling

All voices support `blockOffset` parameter:
- Allows voices to start at exact sample position within a render block
- Critical for transient-accurate timing
- `fadeOutBlockOffset` similarly delays fade-out start

### 3. Output Accumulation

All voices ADD to output buffer (`outL[j] += ...`), never replace. This allows multiple overlapping voices during crossfades.

### 4. Stereo Handling

```typescript
const framesL = frames[0]
const framesR = frames.length === 1 ? frames[0] : frames[1]
```
- Mono files: Left channel is duplicated to right
- Stereo files: Each channel processed separately

### 5. Linear Interpolation

All voices use linear interpolation for sub-sample accuracy:
```typescript
const readInt = readPosition | 0
const alpha = readPosition - readInt
const sample = frames[readInt] + alpha * (frames[readInt + 1] - frames[readInt])
```

### 6. Boundary Safety

```typescript
if (readInt >= 0 && readInt < numberOfFrames - 1)
```
Ensures we never read beyond buffer bounds (need +1 for interpolation).

## TransientPlayMode Enum

```typescript
enum TransientPlayMode {
    Once,    // Play segment once, then silence
    Repeat,  // Loop forward continuously
    Pingpong // Loop forward-backward-forward...
}
```

## Debug Logging

OnceVoice includes debug logging for development:
- Voice creation with segment info and playback rate
- State transitions during fade-in/fade-out
- Amplitude ranges during processing

## File Structure

```
Tape/
├── constants.ts        # Shared constants
├── Segment.ts          # Segment type definition
├── Voice.ts            # Voice interface
├── VoiceState.ts       # State enum
├── OnceVoice.ts        # Single-shot voice
├── RepeatVoice.ts      # Forward-looping voice
├── PingpongVoice.ts    # Bidirectional-looping voice
├── PitchVoice.ts       # Pitch-shift voice
└── PLAYBACK_SYSTEM.md  # This documentation

TapeDeviceProcessor.ts  # Main processor orchestrating voices
```

## Future Considerations

1. **Equal-power crossfades**: Currently OnceVoice and RepeatVoice use linear crossfades. PingpongVoice uses equal-power (cos/sin). Consider unifying.

2. **Crossfade length tuning**: Currently hardcoded at 256 samples (~5.8ms at 44.1kHz). May need adjustment for different content types.

3. **Memory management**: Voices are created/destroyed frequently. Could pool voice objects for performance.

4. **Phase coherence**: When multiple voices overlap, phase relationships are not tracked. Generally not an issue due to crossfading.
