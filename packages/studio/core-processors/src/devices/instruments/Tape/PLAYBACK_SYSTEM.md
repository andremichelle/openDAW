# Tape Playback System Architecture

This document captures all architectural decisions for the tape-based audio playback system in openDAW.

---

## CURRENT STATUS: IMPLEMENTATION COMPLETE (Time-Stretch)

The time-stretch playback system has been reimplemented with clean separation of concerns.

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

### OnceVoice Behavior

OnceVoice is simple:
- Plays audio from start position continuously
- Does NOT self-limit based on segment end - sequencer controls fade-out
- At 100% playback-speed, drift detection allows it to play through multiple transients without crossfades
- At other speeds, sequencer triggers crossfade when appropriate

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

### 2025-12-08 - Implementation Complete & Integrated

**Implemented files**:
- `constants.ts` - All durations in seconds (VOICE_FADE_DURATION, LOOP_FADE_DURATION, LOOP_MARGIN_START, LOOP_MARGIN_END)
- `VoiceState.ts` - Simplified to 3 states (Fading, Active, Done)
- `Voice.ts` - Interface with `done()`, `startFadeOut()`, `readPosition()`, `process()`
- `OnceVoice.ts` - Single-shot playback, fade-in only if position > 0
- `RepeatVoice.ts` - Forward looping with linear crossfade at boundaries
- `PingpongVoice.ts` - Bidirectional looping with equal-power crossfade at bounce points
- `TimeStretchSequencer.ts` - Orchestrates voices, handles transient boundaries

**Integration with TapeDeviceProcessor**:
- `#processPassTimestretch` now delegates to `TimeStretchSequencer`
- Sequencer is created per-block with state transferred to/from lane
- PitchVoice instances are preserved separately (pitch-stretch mode)
- Voice instances are managed by sequencer (time-stretch mode)

**Key implementation details**:
- All constants in seconds, converted to samples at runtime using `sampleRate`
- Voices are "dumb" - only respond to commands, never auto-fade
- Sequencer is "smart" - handles all timing decisions
- Sample-exact block offsets for transient-accurate timing
- Drift detection: at near-100% speed, voice continues without crossfade; drift accumulates until threshold triggers resync

---

## RESOLVED DECISIONS

### D1: Transparency
**Perceptually identical** at 100% - crossfades are always acceptable. No need for bit-identical passthrough mode.

### D2: OnceVoice Budget Exhaustion
When playback-rate > 1.0 and voice runs out of audio before next transient: **Silence**. Voice ends, output is silent until next transient starts.

### D3: Crossfade at Transient Boundaries
**Crossfade when drift exceeds threshold** - At near-100% playback-speed, voice continues without crossfade to avoid phasing. When drift accumulates past threshold, or when playback-speed differs significantly from 100%, crossfade to new voice.

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
OnceVoice plays continuously from its start position until the sequencer triggers fade-out. It does not self-limit based on segment boundaries - the sequencer controls when to stop. Margins are only for Repeat/Pingpong looping.

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

### D13: Near-100% Playback-Speed (Drift Detection)
When playback-speed is close to 100%, crossfading would cause phasing artifacts (near-identical audio overlapping).

**Solution**: Drift detection
- When crossing a transient boundary, check if current voice's read position is within threshold of expected position
- If within threshold: **continue current voice** (no crossfade), just update transient index
- If outside threshold: fade out old voice, spawn new voice (crossfade)
- Drift accumulates over multiple transients until threshold is exceeded, triggering a resync crossfade

**Threshold**: `VOICE_FADE_DURATION` in samples (~5ms)

```
At 100% speed:
Transient:    0      1      2      3      ...  N
Voice:        [=============== continues =====>] (single voice, no crossfades)
Drift:        0      ~0     ~0     ~0          accumulates...

At 95% speed (slower):
Transient:    0      1      2      3
Voice:        [--X]  [--X]  [--X]  [--X]  (crossfade at each boundary)
              ↑ drift exceeds threshold, new voice spawned
```

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

## File Structure

```
Tape/
├── constants.ts             # Shared constants (in seconds)
├── Voice.ts                 # Voice interface
├── VoiceState.ts            # State enum (Fading, Active, Done)
├── OnceVoice.ts             # Single-shot voice
├── RepeatVoice.ts           # Forward-looping voice
├── PingpongVoice.ts         # Bidirectional-looping voice
├── PitchVoice.ts            # Pitch-shift voice (for pitch-stretch mode)
├── TimeStretchSequencer.ts  # Orchestrates time-stretch voices
└── PLAYBACK_SYSTEM.md       # This documentation

TapeDeviceProcessor.ts       # Main processor (integrates both modes)
```

## Future Considerations

1. **Implement PitchStretchSequencer** - Similar architecture for pitch-stretch mode (warp marker based)
2. **Equal-power crossfades** - Currently OnceVoice and RepeatVoice use linear crossfades. PingpongVoice uses equal-power (cos/sin). Consider unifying if audio quality demands it.
3. **Optimize sequencer creation** - Currently creating a new TimeStretchSequencer per block. Could cache per-lane if performance is an issue.
