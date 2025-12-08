# Tape Playback System Architecture

This document captures all architectural decisions for the tape-based audio playback system in openDAW.

---

## Key Terminology

| Term | Definition |
|------|------------|
| **playback-speed** | Overall speed determined by BPM (tempo). 100% = original tempo, 50% = half tempo (slower), 200% = double tempo (faster) |
| **playback-rate** | Pitch adjustment. 1.0 = original pitch, 2.0 = octave up (consumes audio 2x faster), 0.5 = octave down (consumes audio 0.5x slower) |
| **time-stretch** | Transient-based granular playback (transient after transient) |
| **segment** | Audio between two transient markers |
| **drift** | Difference between where voice is reading vs where it should be reading |

---

## Behavior by Scenario

### Scenario A: Matching BPM (100% playback-speed), playback-rate = 1.0

**Expected**: Single voice plays through entire audio without any crossfades. Output = original sample (transparency).

- Voice starts at first transient
- Voice continues through all transient boundaries without interruption
- Drift detection allows voice to continue because read position matches expected position
- No looping ever needed

### Scenario B: Matching BPM (100% playback-speed), playback-rate = 2.0

**Expected**: Voice consumes audio 2x faster than output time. Need to LOOP to fill the time gap.

- At each transient: `audioSamplesNeeded = outputTime * playbackRate = segmentLength * 2`
- We have `segmentLength` audio but need `segmentLength * 2` worth
- Must loop (Repeat/Pingpong) or have silence (Once mode)

### Scenario C: Matching BPM (100% playback-speed), playback-rate = 0.5

**Expected**: Voice consumes audio 0.5x slower than output time. Audio will be cut short.

- At each transient: `audioSamplesNeeded = outputTime * playbackRate = segmentLength * 0.5`
- We have MORE audio than we need
- Voice plays until next transient arrives, then crossfades to new voice
- No looping needed

### Scenario D: Slower BPM (e.g., 50% playback-speed), playback-rate = 1.0

**Expected**: More output time than audio available. Need to LOOP (Repeat/Pingpong) or have silence (Once).

- Output time until next transient = 2x segment length
- Audio available = segment length
- Must loop to fill the gap, OR play once then silence

### Scenario E: Faster BPM (e.g., 200% playback-speed), playback-rate = 1.0

**Expected**: Less output time than audio. Audio gets cut short.

- Output time until next transient = 0.5x segment length
- Audio available = segment length
- Voice plays until next transient arrives (halfway through segment), then crossfades

---

## Core Rules

### Rule 1: Sequencer Controls Everything
- Voices are "dumb" - they only play audio and respond to `startFadeOut()`
- Sequencer decides when to spawn voices, when to fade them out
- Voice never auto-stops based on segment boundaries

### Rule 2: Voice Exposes State for Sequencer Queries
- `readPosition()` - where voice is currently reading in audio samples
- `segmentEnd()` - where this voice's segment ends
- `setSegmentEnd()` - sequencer can extend segment when voice continues through transients
- `done()` - is voice finished?

### Rule 3: Fade-In Rule
- Position = 0 (start of file): NO fade-in
- Position > 0: fade-in required (cutting into existing audio)

### Rule 4: No Clicks Ever
- All transitions use crossfades
- Discontinuities (seek, loop) fade out current voices first

### Rule 5: Drift Detection for Near-100% Playback
When effective speed (playback-speed * playback-rate) is close to 100%:
- Check if voice's read position is close to expected position for new transient
- If close: continue voice, update segment end, NO crossfade
- If far: crossfade to new voice
- Small drifts accumulate until threshold exceeded, then resync with crossfade
- Threshold = VOICE_FADE_DURATION in samples

### Rule 6: Looping Decision (needsLooping)
Determines if we need looping (for Repeat/Pingpong modes):

```
outputSamplesUntilNext = tempoMap.intervalToSeconds(currentPpqn, nextPpqn) * sampleRate
audioSamplesNeeded = outputSamplesUntilNext * playbackRate
segmentLength = audio samples available in this segment

speedRatio = segmentLength / audioSamplesNeeded
closeToUnity = speedRatio >= 0.99 && speedRatio <= 1.01

needsLooping = !closeToUnity && audioSamplesNeeded > segmentLength
```

**Important**: When `speedRatio` is within 1% of 1.0, we do NOT loop even if `audioSamplesNeeded > segmentLength`. This prevents phase artifacts when playing at near-original speed.

### Rule 7: Last Transient
- If no next transient exists, `outputSamplesUntilNext = INFINITY`
- Repeat/Pingpong will loop forever until fade-out is triggered
- Once will play once then silence

---

## Voice Types

### OnceVoice
- Plays segment once
- If audio exhausted before next transient: SILENCE (no looping)
- Sequencer triggers fade-out when reaching segment end OR when next transient arrives

### RepeatVoice
- Plays segment, then loops forward within margin region
- First iteration: start → end-MARGIN_END (includes attack)
- Loop region: start+MARGIN_START → end-MARGIN_END (skips attack)
- Linear crossfade at loop boundary

### PingpongVoice
- Plays segment, then bounces back and forth within margin region
- First iteration: start → end-MARGIN_END (includes attack)
- Bounce region: start+MARGIN_START ↔ end-MARGIN_END
- Equal-power crossfade (cos/sin) at bounce points

---

## Constants (in seconds)

- `VOICE_FADE_DURATION` = 0.020 (20ms) - voice start/stop crossfades, also drift threshold
- `LOOP_FADE_DURATION` = 0.005 (5ms) - loop boundary crossfades
- `LOOP_MARGIN_START` = 0.006 (6ms) - skip attack when looping
- `LOOP_MARGIN_END` = 0.006 (6ms) - avoid bleeding into next transient

---

## Architecture

### Sequencer Lives on Lane
- `TimeStretchSequencer` is created once per lane, NOT per block
- No memory allocation in the audio thread
- State persists across blocks: `voices`, `currentTransientIndex`, `accumulatedDrift`

### Process Flow
1. TapeDeviceProcessor receives block
2. Transfers voices to lane's sequencer
3. Calls `sequencer.process()` with all parameters
4. Sequencer handles transient boundaries, drift detection, voice lifecycle
5. Transfers voices back to lane

### Tempo Map Integration
- `tempoMap.intervalToSeconds(fromPpqn, toPpqn)` handles tempo automation
- Used to calculate accurate output duration between transients
- Critical for correct looping decisions under tempo changes

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
├── TimeStretchSequencer.ts  # Orchestrates time-stretch voices
└── PLAYBACK_SYSTEM.md       # This documentation

TapeDeviceProcessor.ts       # Main processor (integrates both modes)
```
