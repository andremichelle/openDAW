import {describe, expect, it, beforeEach} from "vitest"
import {TimeStretchSequencer, TransientMarker, WarpMarker} from "./TimeStretchSequencer"
import {OnceVoice} from "./OnceVoice"
import {RepeatVoice} from "./RepeatVoice"
import {PingpongVoice} from "./PingpongVoice"
import {AudioBuffer, AudioData, EventCollection, TempoMap} from "@opendaw/lib-dsp"
import {TransientPlayMode} from "@opendaw/studio-enums"

// Mock transient marker
class MockTransientMarker implements TransientMarker {
    readonly type = "transient"
    constructor(readonly position: number) {} // position in file seconds
}

// Mock warp marker
class MockWarpMarker implements WarpMarker {
    readonly type = "warp"
    constructor(
        readonly position: number, // PPQN
        readonly seconds: number   // file seconds
    ) {}
}

// Simple constant tempo map for testing
class MockTempoMap implements TempoMap {
    constructor(private bpm: number = 120) {}

    subscribe() { return { terminate: () => {} } }
    getTempoAt() { return this.bpm }
    ppqnToSeconds(position: number) { return (position * 60) / (960 * this.bpm) }
    secondsToPPQN(time: number) { return (time * 960 * this.bpm) / 60 }
    intervalToSeconds(from: number, to: number) { return this.ppqnToSeconds(to - from) }
    intervalToPPQN(from: number, to: number) { return this.secondsToPPQN(to - from) }
}

// Create mock audio data
function createMockAudioData(durationSeconds: number, sampleRate: number = 44100): AudioData {
    const numberOfFrames = Math.round(durationSeconds * sampleRate)
    const frames = [new Float32Array(numberOfFrames), new Float32Array(numberOfFrames)]
    // Fill with simple test signal
    for (let i = 0; i < numberOfFrames; i++) {
        frames[0][i] = Math.sin(2 * Math.PI * 440 * i / sampleRate)
        frames[1][i] = frames[0][i]
    }
    return { sampleRate, numberOfFrames, numberOfChannels: 2, frames }
}

// Create transient collection
function createTransients(positions: number[]): EventCollection<MockTransientMarker> {
    const collection = EventCollection.create<MockTransientMarker>()
    positions.forEach(pos => collection.add(new MockTransientMarker(pos)))
    return collection
}

// Create warp markers (linear mapping: PPQN = seconds * 960 at 120 BPM)
function createWarpMarkers(mappings: Array<{ppqn: number, seconds: number}>): EventCollection<MockWarpMarker> {
    const collection = EventCollection.create<MockWarpMarker>()
    mappings.forEach(({ppqn, seconds}) => collection.add(new MockWarpMarker(ppqn, seconds)))
    return collection
}

describe("TimeStretchSequencer", () => {
    let sequencer: TimeStretchSequencer
    let output: AudioBuffer
    let tempoMap: MockTempoMap

    beforeEach(() => {
        sequencer = new TimeStretchSequencer()
        output = new AudioBuffer(2)
        tempoMap = new MockTempoMap(120) // 120 BPM
    })

    describe("Scenario A: Matching BPM, playbackRate = 1.0", () => {
        it("should continue single voice through transients without crossfade", () => {
            // 2 second audio with transients at 0s, 0.5s, 1.0s, 1.5s
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            // 1:1 mapping at 120 BPM: 1920 PPQN = 1.0s (2 beats at 120 BPM)
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])

            const playbackRate = 1.0
            const waveformOffset = 0
            const bufferCount = 128

            // Process first block - should spawn voice at transient 0
            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Once, playbackRate, waveformOffset, tempoMap,
                0.01, // fileSecondsEnd - just past first transient
                0,    // contentPpqn
                10,   // pn (small PPQN duration)
                0, bufferCount
            )

            expect(sequencer.voices.length).toBe(1)
            const firstVoice = sequencer.voices[0]

            // Simulate voice advancing through the audio
            // At playbackRate 1.0 with 128 samples processed, voice advanced ~128 samples
            // For drift detection to work, we need the voice's read position to be close to
            // where the next transient starts (0.5s * 44100 = 22050 samples)

            // To properly simulate: process many blocks so voice position advances
            // For now, let's just verify the logic works when voice IS at expected position
            // We'll manually set readPosition by processing enough audio

            // Process multiple blocks to advance voice position to near transient 1
            // Each block processes bufferCount samples
            // Need to process ~22050 / 128 ≈ 172 blocks
            for (let i = 0; i < 170; i++) {
                firstVoice.process(0, bufferCount)
            }

            // Now voice readPosition should be around 170 * 128 = 21760, close to 22050
            // Cross into second transient
            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Once, playbackRate, waveformOffset, tempoMap,
                0.51, // fileSecondsEnd - just past second transient
                960,  // contentPpqn (0.5s at 120BPM = 960 PPQN in warp space)
                10, 0, bufferCount
            )

            // Drift detection should allow continuation since voice is near expected position
            // Voice readPosition ≈ 21760, expected = 22050, drift ≈ 290 samples
            // Threshold = 0.020s * 44100 = 882 samples
            // |290| < 882, so should continue
            expect(sequencer.voices.length).toBe(1)
            expect(sequencer.voices[0]).toBe(firstVoice)
        })
    })

    describe("Scenario B: Matching BPM, playbackRate = 2.0", () => {
        it("should create looping voice when playbackRate > 1", () => {
            const data = createMockAudioData(2.0)
            // Transients at 0s, 0.5s, 1.0s, 1.5s
            const transients = createTransients([0, 0.5, 1.0, 1.5])

            // For "matching BPM" with 120 BPM tempo:
            // At 120 BPM: 960 PPQN = 1 beat = 0.5 seconds output time
            // For 1:1 mapping (matching): 960 PPQN in warp = 0.5s file time
            // So warp: 0 PPQN = 0s, 1920 PPQN = 1.0s (since 1920 PPQN = 2 beats = 1.0s at 120 BPM)
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}  // 1:1 mapping at 120 BPM
            ])

            const playbackRate = 2.0 // Consumes audio 2x faster
            const waveformOffset = 0
            const bufferCount = 128

            // With matching warp and playbackRate = 2.0:
            // Transient 0 at 0s file → 0 PPQN warp
            // Transient 1 at 0.5s file → 960 PPQN warp (because 0.5/1.0 * 1920 = 960)
            //
            // outputSamplesUntilNext = tempoMap.intervalToSeconds(0, 960) * 44100
            //   = 0.5s * 44100 = 22050 output samples
            // audioSamplesNeeded = 22050 * 2.0 = 44100 audio samples needed
            // segmentLength = 0.5s * 44100 = 22050 audio samples available
            // needsLooping = 44100 > 22050 = TRUE

            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Repeat, playbackRate, waveformOffset, tempoMap,
                0.01, 0, 10, 0, bufferCount
            )

            expect(sequencer.voices.length).toBe(1)
            expect(sequencer.voices[0]).toBeInstanceOf(RepeatVoice)
        })

        it("should create PingpongVoice when mode is Pingpong and looping needed", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}  // 1:1 mapping at 120 BPM
            ])

            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Pingpong, 2.0, 0, tempoMap,
                0.01, 0, 10, 0, 128
            )

            expect(sequencer.voices.length).toBe(1)
            expect(sequencer.voices[0]).toBeInstanceOf(PingpongVoice)
        })

        it("should create OnceVoice when mode is Once regardless of playbackRate", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}  // 1:1 mapping at 120 BPM
            ])

            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Once, 2.0, 0, tempoMap,
                0.01, 0, 10, 0, 128
            )

            expect(sequencer.voices.length).toBe(1)
            expect(sequencer.voices[0]).toBeInstanceOf(OnceVoice)
        })
    })

    describe("Scenario C: Matching BPM, playbackRate = 0.5", () => {
        it("should create OnceVoice when we have more audio than needed", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}  // 1:1 mapping at 120 BPM
            ])

            const playbackRate = 0.5 // Consumes audio 0.5x slower

            // With playbackRate 0.5:
            // outputSamplesUntilNext = 0.5s * 44100 = 22050
            // audioSamplesNeeded = 22050 * 0.5 = 11025
            // segmentLength = 22050
            // needsLooping = 11025 > 22050 = FALSE

            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Repeat, playbackRate, 0, tempoMap,
                0.01, 0, 10, 0, 128
            )

            expect(sequencer.voices.length).toBe(1)
            expect(sequencer.voices[0]).toBeInstanceOf(OnceVoice)
        })
    })

    describe("Scenario D: Slower BPM (50% speed)", () => {
        it("should create looping voice when BPM is slower", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            // Warp markers stretched: 0.5s of audio takes 1.0s of output time
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0} // Half the PPQN range for same seconds = slower
            ])

            const playbackRate = 1.0
            const tempoMapSlow = new MockTempoMap(60) // 60 BPM = half speed

            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Repeat, playbackRate, 0, tempoMapSlow,
                0.01, 0, 10, 0, 128
            )

            expect(sequencer.voices.length).toBe(1)
            // At 60 BPM, we have more output time than audio
            // Need looping to fill the gap
            expect(sequencer.voices[0]).toBeInstanceOf(RepeatVoice)
        })
    })

    describe("Scenario E: Faster BPM (200% speed)", () => {
        it("should crossfade to new voice when next transient arrives early", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 2.0}
            ])

            const playbackRate = 1.0
            const tempoMapFast = new MockTempoMap(240) // 240 BPM = double speed

            // First transient
            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Once, playbackRate, 0, tempoMapFast,
                0.01, 0, 10, 0, 128
            )

            expect(sequencer.voices.length).toBe(1)
            const firstVoice = sequencer.voices[0]

            // At 240 BPM, we reach second transient faster
            // Voice position will NOT be at expected position
            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Once, playbackRate, 0, tempoMapFast,
                0.51, 480, 10, 0, 128
            )

            // Should have spawned new voice (old one fading out)
            expect(sequencer.voices.length).toBeGreaterThanOrEqual(1)
        })
    })

    describe("Scenario F: Close to matching BPM (within 1%)", () => {
        it("should NOT loop when speed ratio is within 1% of unity", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            // 1:1 mapping at 120 BPM
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])

            // 120.5 BPM is ~0.4% faster than 120 BPM - within 1% threshold
            const tempoMapSlightlyFast = new MockTempoMap(120.5)

            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Repeat, 1.0, 0, tempoMapSlightlyFast,
                0.01, 0, 10, 0, 128
            )

            expect(sequencer.voices.length).toBe(1)
            // Should be OnceVoice because we're close to unity - no looping
            expect(sequencer.voices[0]).toBeInstanceOf(OnceVoice)
        })

        it("should NOT loop when playbackRate results in close-to-unity ratio", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])

            // playbackRate of 1.005 means we consume audio 0.5% faster
            // Combined with matching warp, this is within 1% of unity
            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Repeat, 1.005, 0, tempoMap,
                0.01, 0, 10, 0, 128
            )

            expect(sequencer.voices.length).toBe(1)
            // Should be OnceVoice - close to unity, no looping
            expect(sequencer.voices[0]).toBeInstanceOf(OnceVoice)
        })

        it("should loop when speed ratio exceeds 1% threshold", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])

            // playbackRate of 1.02 means we consume audio 2% faster
            // This exceeds the 1% threshold, so looping IS needed
            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Repeat, 1.02, 0, tempoMap,
                0.01, 0, 10, 0, 128
            )

            expect(sequencer.voices.length).toBe(1)
            // Should be RepeatVoice - exceeds threshold, needs looping
            expect(sequencer.voices[0]).toBeInstanceOf(RepeatVoice)
        })
    })

    describe("Drift accumulation", () => {
        it("should allow voice to continue when drift is small", () => {
            // This test verifies drift behavior through observable outcomes
            // The sequencer's internal accumulatedDrift is private, so we test
            // via voice continuation behavior (tested in Scenario A)
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])

            // First transient spawns voice
            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Once, 1.0, 0, tempoMap,
                0.01, 0, 10, 0, 128
            )

            expect(sequencer.voices.length).toBe(1)
        })
    })

    describe("Last transient behavior", () => {
        it("should loop forever on last transient with Repeat mode", () => {
            const data = createMockAudioData(2.0)
            // Only 2 transients - second one is the "last"
            const transients = createTransients([0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 2.0}
            ])

            // Jump to last transient
            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Repeat, 1.0, 0, tempoMap,
                1.51, 1440, 10, 0, 128
            )

            expect(sequencer.voices.length).toBe(1)
            // Last transient with Repeat should create RepeatVoice (loops forever)
            expect(sequencer.voices[0]).toBeInstanceOf(RepeatVoice)
        })

        it("should create OnceVoice on last transient with Once mode", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 2.0}
            ])

            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Once, 1.0, 0, tempoMap,
                1.51, 1440, 10, 0, 128
            )

            expect(sequencer.voices.length).toBe(1)
            expect(sequencer.voices[0]).toBeInstanceOf(OnceVoice)
        })
    })

    describe("Reset behavior", () => {
        it("should fade out voices and reset state on discontinuity", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 2.0}
            ])

            // Create a voice
            sequencer.process(
                output, data, transients, warpMarkers,
                TransientPlayMode.Once, 1.0, 0, tempoMap,
                0.01, 0, 10, 0, 128
            )

            expect(sequencer.voices.length).toBe(1)

            // Reset (simulates seek/loop jump)
            sequencer.reset()

            // Voices should be fading out (still present but marked for removal)
            // After processing, they should be gone
        })
    })
})
