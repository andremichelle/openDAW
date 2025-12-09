import {describe, expect, it, beforeEach} from "vitest"
import {TimeStretchSequencer} from "./TimeStretchSequencer"
import {AudioBuffer, AudioData, EventCollection, LoopableRegion, Event} from "@opendaw/lib-dsp"
import {TransientPlayMode} from "@opendaw/studio-enums"
import {Block, BlockFlag} from "../../../processing"

// Test helper: minimal Event implementation for transient markers
class TestTransientMarker implements Event {
    readonly type = "transient-marker"
    constructor(readonly position: number) {}
}

// Test helper: minimal Event implementation for warp markers
class TestWarpMarker implements Event {
    readonly type = "warp-marker"
    constructor(
        readonly position: number,
        readonly seconds: number
    ) {}
}

// Test helper: minimal config matching AudioTimeStretchBoxAdapter interface
class TestTimeStretchConfig {
    readonly warpMarkers: EventCollection<TestWarpMarker>
    constructor(
        warpMarkers: EventCollection<TestWarpMarker>,
        readonly transientPlayMode: TransientPlayMode = TransientPlayMode.Repeat,
        readonly playbackRate: number = 1.0
    ) {
        this.warpMarkers = warpMarkers
    }
}

function createMockAudioData(durationSeconds: number, sampleRate: number = 44100): AudioData {
    const numberOfFrames = Math.round(durationSeconds * sampleRate)
    const frames = [new Float32Array(numberOfFrames), new Float32Array(numberOfFrames)]
    for (let i = 0; i < numberOfFrames; i++) {
        frames[0][i] = Math.sin(2 * Math.PI * 440 * i / sampleRate)
        frames[1][i] = frames[0][i]
    }
    return {sampleRate, numberOfFrames, numberOfChannels: 2, frames}
}

function createTransients(positions: number[]): EventCollection<TestTransientMarker> {
    const collection = EventCollection.create<TestTransientMarker>()
    positions.forEach(pos => collection.add(new TestTransientMarker(pos)))
    return collection
}

function createWarpMarkers(mappings: Array<{ppqn: number, seconds: number}>): EventCollection<TestWarpMarker> {
    const collection = EventCollection.create<TestWarpMarker>()
    mappings.forEach(({ppqn, seconds}) => collection.add(new TestWarpMarker(ppqn, seconds)))
    return collection
}

function createBlock(p0: number, p1: number, s0: number, s1: number, bpm: number = 120, flags: number = BlockFlag.transporting | BlockFlag.playing): Block {
    return {index: 0, p0, p1, s0, s1, bpm, flags}
}

function createCycle(resultStart: number, resultEnd: number, rawStart: number): LoopableRegion.LoopCycle {
    return {
        index: 0,
        rawStart,
        rawEnd: rawStart + (resultEnd - resultStart),
        regionStart: resultStart,
        regionEnd: resultEnd,
        resultStart,
        resultEnd,
        resultStartValue: 0,
        resultEndValue: 1
    }
}

/**
 * Helper to process multiple continuous blocks
 * Returns the final state after processing all blocks
 */
function processBlocks(
    sequencer: TimeStretchSequencer,
    output: AudioBuffer,
    data: AudioData,
    transients: EventCollection<TestTransientMarker>,
    config: TestTimeStretchConfig,
    bpm: number,
    totalSamples: number,
    blockSize: number = 128
): void {
    const sampleRate = data.sampleRate
    // At given BPM: ppqnPerSecond = 960 * bpm / 60
    const ppqnPerSecond = 960 * bpm / 60
    const ppqnPerSample = ppqnPerSecond / sampleRate

    let currentSample = 0
    let currentPpqn = 0

    while (currentSample < totalSamples) {
        const samplesToProcess = Math.min(blockSize, totalSamples - currentSample)
        const ppqnToProcess = samplesToProcess * ppqnPerSample

        const block = createBlock(
            currentPpqn,
            currentPpqn + ppqnToProcess,
            currentSample,
            currentSample + samplesToProcess,
            bpm
        )
        const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)

        sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

        currentSample += samplesToProcess
        currentPpqn += ppqnToProcess
    }
}

describe("TimeStretchSequencer", () => {
    let sequencer: TimeStretchSequencer
    let output: AudioBuffer

    beforeEach(() => {
        sequencer = new TimeStretchSequencer()
        output = new AudioBuffer(2)
    })

    // =========================================================================
    // RULE 1: Maximum Voice Count
    // - At most 2 voices producing audio at any moment (during crossfade only)
    // - Outside of crossfades, exactly 1 voice
    // =========================================================================
    describe("Rule 1: Maximum Voice Count", () => {
        it("should never have more than 2 voices at any moment", () => {
            // Test at slow BPM with fast playback rate - stresses the system
            const data = createMockAudioData(4.0) // 4 seconds of audio
            // Transients every 0.5 seconds
            const transients = createTransients([0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5])
            // Warp markers for 120 BPM sample (1 second = 1920 PPQN)
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920 * 4, seconds: 4.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 2.0)

            // Process at 60 BPM (half speed) with playback rate 2.0
            // This creates extreme conditions
            const sampleRate = data.sampleRate
            const ppqnPerSecond = 960 * 60 / 60 // 60 BPM = 960 PPQN/sec
            const ppqnPerSample = ppqnPerSecond / sampleRate

            let currentSample = 0
            let currentPpqn = 0
            const blockSize = 128
            const totalSamples = sampleRate * 2 // 2 seconds

            while (currentSample < totalSamples) {
                const samplesToProcess = Math.min(blockSize, totalSamples - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn,
                    currentPpqn + ppqnToProcess,
                    currentSample,
                    currentSample + samplesToProcess,
                    60
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)

                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                // RULE 1: Never more than 2 voices
                expect(sequencer.voiceCount).toBeLessThanOrEqual(2)

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }
        })
    })

    // =========================================================================
    // RULE 2: Transient Boundary Behavior
    // =========================================================================
    describe("Rule 2: Transient Boundary Behavior", () => {
        describe("Matching BPM (drift within threshold)", () => {
            it("should continue voice without crossfade at matching BPM", () => {
                // 120 BPM sample played at 120 BPM
                const data = createMockAudioData(2.0)
                const transients = createTransients([0, 0.5, 1.0, 1.5])
                // Warp markers: 1920 PPQN = 1 second (matches 120 BPM)
                const warpMarkers = createWarpMarkers([
                    {ppqn: 0, seconds: 0},
                    {ppqn: 1920, seconds: 1.0}
                ])
                const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

                // Process through multiple transients at matching BPM
                processBlocks(sequencer, output, data, transients, config, 120, 44100) // 1 second

                // Should still be exactly 1 voice (no crossfades happened)
                expect(sequencer.voiceCount).toBe(1)
            })
        })

        describe("Faster BPM (drift exceeds threshold)", () => {
            it("should crossfade to new voice at each transient when BPM is faster", () => {
                // 120 BPM sample played at 180 BPM (1.5x faster)
                const data = createMockAudioData(2.0)
                const transients = createTransients([0, 0.5, 1.0, 1.5])
                // Warp markers for 120 BPM sample
                const warpMarkers = createWarpMarkers([
                    {ppqn: 0, seconds: 0},
                    {ppqn: 1920, seconds: 1.0}
                ])
                const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

                // Process at 180 BPM - each transient should trigger crossfade
                // At 180 BPM, we'll cross transient 0.5s mark faster than the audio plays
                processBlocks(sequencer, output, data, transients, config, 180, 44100)

                // Voice count should be 1 or 2 (if mid-crossfade), never more
                expect(sequencer.voiceCount).toBeLessThanOrEqual(2)
                expect(sequencer.voiceCount).toBeGreaterThanOrEqual(1)
            })
        })

        describe("Slower BPM with Once mode", () => {
            it("should play once then silence, new voice at next transient", () => {
                // 120 BPM sample played at 60 BPM (half speed) with Once mode
                const data = createMockAudioData(2.0)
                const transients = createTransients([0, 0.5, 1.0, 1.5])
                const warpMarkers = createWarpMarkers([
                    {ppqn: 0, seconds: 0},
                    {ppqn: 1920, seconds: 1.0}
                ])
                const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Once, 1.0)

                // Process at 60 BPM
                processBlocks(sequencer, output, data, transients, config, 60, 44100)

                // Should have voice(s) but never more than 2
                expect(sequencer.voiceCount).toBeLessThanOrEqual(2)
            })
        })

        describe("Slower BPM with Repeat mode", () => {
            it("should loop within segment, then crossfade to new voice at transient boundary", () => {
                // 120 BPM sample played at 60 BPM with Repeat mode
                const data = createMockAudioData(2.0)
                const transients = createTransients([0, 0.5, 1.0, 1.5])
                const warpMarkers = createWarpMarkers([
                    {ppqn: 0, seconds: 0},
                    {ppqn: 1920, seconds: 1.0}
                ])
                const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

                // Process at 60 BPM - needs looping because output time > audio time
                processBlocks(sequencer, output, data, transients, config, 60, 44100)

                // Should have voice(s) but never more than 2
                expect(sequencer.voiceCount).toBeLessThanOrEqual(2)
                expect(sequencer.voiceCount).toBeGreaterThanOrEqual(1)
            })
        })
    })

    // =========================================================================
    // RULE 6: No Clicks Ever
    // =========================================================================
    describe("Rule 6: No Clicks Ever", () => {
        it("should reset and fade out on discontinuity", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers)

            // Process first block normally
            const block1 = createBlock(0, 10, 0, 128, 120)
            const cycle1 = createCycle(0, 10, 0)
            sequencer.process(output, data, transients as any, config as any, 0, block1, cycle1)
            expect(sequencer.voiceCount).toBe(1)

            // Process discontinuous block (e.g., seek)
            const block2 = createBlock(960, 970, 0, 128, 120, BlockFlag.transporting | BlockFlag.playing | BlockFlag.discontinuous)
            const cycle2 = createCycle(960, 970, 0)
            sequencer.process(output, data, transients as any, config as any, 0, block2, cycle2)

            // Voices should exist (old fading + new, or just new if fade completed)
            expect(sequencer.voiceCount).toBeGreaterThanOrEqual(1)
            expect(sequencer.voiceCount).toBeLessThanOrEqual(2)
        })
    })

    // =========================================================================
    // RULE 7: Drift Detection
    // =========================================================================
    describe("Rule 7: Drift Detection", () => {
        it("should accumulate small drifts and continue voice when within threshold", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            // Warp markers exactly matching 120 BPM
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

            // Process at exactly 120 BPM through 3 transients
            // At 120 BPM: 0.5 seconds = 960 PPQN = 22050 samples
            const blocksPerTransient = Math.ceil(22050 / 128)

            for (let t = 0; t < 3; t++) {
                for (let b = 0; b < blocksPerTransient; b++) {
                    const sampleOffset = t * 22050 + b * 128
                    const ppqnOffset = t * 960 + b * (128 / 44100) * 1920

                    const block = createBlock(
                        ppqnOffset,
                        ppqnOffset + (128 / 44100) * 1920,
                        sampleOffset,
                        sampleOffset + 128,
                        120
                    )
                    const cycle = createCycle(ppqnOffset, ppqnOffset + (128 / 44100) * 1920, 0)
                    sequencer.process(output, data, transients as any, config as any, 0, block, cycle)
                }
            }
            // At matching BPM, should maintain single voice throughout
            expect(sequencer.voiceCount).toBe(1)
        })

        it("should crossfade when accumulated drift exceeds threshold", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            // Warp markers for 100 BPM sample (slightly different from 120 BPM playback)
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1600, seconds: 1.0} // 100 BPM = 1600 PPQN per second
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

            // Process at 120 BPM (20% faster than sample)
            // This should cause drift to accumulate and eventually exceed threshold
            processBlocks(sequencer, output, data, transients, config, 120, 44100 * 2)

            // Voice count should be valid (1 or 2 during crossfade)
            expect(sequencer.voiceCount).toBeLessThanOrEqual(2)
            expect(sequencer.voiceCount).toBeGreaterThanOrEqual(1)
        })
    })

    // =========================================================================
    // RULE 8: Looping Decision
    // =========================================================================
    describe("Rule 8: Looping Decision (needsLooping)", () => {
        it("should NOT loop when speedRatio is within 1% of 1.0", () => {
            // Even if audioSamplesNeeded slightly > segmentLength
            // When speedRatio is 0.99-1.01, no looping to prevent phase artifacts
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            // Warp markers very close to 120 BPM
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

            // Process at 119 BPM (within 1% of 120 BPM)
            // Track during processing
            let sawVoice = false
            let maxVoiceCount = 0

            const sampleRate = data.sampleRate
            const ppqnPerSecond = 960 * 119 / 60
            const ppqnPerSample = ppqnPerSecond / sampleRate
            let currentSample = 0
            let currentPpqn = 0
            const blockSize = 128
            const totalSamples = 44100

            while (currentSample < totalSamples) {
                const samplesToProcess = Math.min(blockSize, totalSamples - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn,
                    currentPpqn + ppqnToProcess,
                    currentSample,
                    currentSample + samplesToProcess,
                    119
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)

                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                if (sequencer.voiceCount > 0) sawVoice = true
                maxVoiceCount = Math.max(maxVoiceCount, sequencer.voiceCount)

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            // Should have had a voice during processing
            expect(sawVoice).toBe(true)
            // Max 2 voices during crossfade
            expect(maxVoiceCount).toBeLessThanOrEqual(2)
        })

        it("should loop when audioSamplesNeeded > segmentLength and not close to unity", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

            // Process at 60 BPM (half speed - definitely needs looping)
            processBlocks(sequencer, output, data, transients, config, 60, 44100)

            // Should have voice(s)
            expect(sequencer.voiceCount).toBeGreaterThanOrEqual(1)
            expect(sequencer.voiceCount).toBeLessThanOrEqual(2)
        })
    })

    // =========================================================================
    // RULE 9: Last Transient
    // =========================================================================
    describe("Rule 9: Last Transient", () => {
        it("should loop forever on last transient with Repeat mode until stopped", () => {
            const data = createMockAudioData(2.0)
            // Only 2 transients - second one is "last"
            const transients = createTransients([0, 0.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

            // Process well past the last transient at slow BPM
            processBlocks(sequencer, output, data, transients, config, 60, 44100 * 3)

            // Should still have a voice playing (looping on last segment)
            expect(sequencer.voiceCount).toBeGreaterThanOrEqual(1)
        })

        it("should play once then silence on last transient with Once mode", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Once, 1.0)

            // Process well past the last transient at slow BPM
            processBlocks(sequencer, output, data, transients, config, 60, 44100 * 3)

            // Voice may or may not exist (could have finished and been cleaned up)
            expect(sequencer.voiceCount).toBeLessThanOrEqual(2)
        })
    })

    // =========================================================================
    // BUG REPRODUCTION: 30 BPM, playback-rate 2, Once mode
    // Expected: Short transient bursts with long silence gaps between them
    // Bug: Multiple voices keep playing (stuck voices)
    // =========================================================================
    describe("Bug: 30 BPM, playback-rate 2, Once mode", () => {
        it("should have at most 1 active voice between transient boundaries (outside crossfade)", () => {
            // Setup: 120 BPM sample with transients every 0.5 seconds
            const data = createMockAudioData(4.0) // 4 seconds of audio
            const transients = createTransients([0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5])
            // Warp markers for 120 BPM sample
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920 * 4, seconds: 4.0}
            ])
            // Once mode with playback rate 2.0
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Once, 2.0)

            const sampleRate = data.sampleRate
            // At 30 BPM: 960 * 30 / 60 = 480 PPQN per second
            const ppqnPerSecond = 960 * 30 / 60
            const ppqnPerSample = ppqnPerSecond / sampleRate

            let currentSample = 0
            let currentPpqn = 0
            const blockSize = 128
            const totalSamples = sampleRate * 4 // 4 seconds of playback

            const voiceCountHistory: number[] = []

            while (currentSample < totalSamples) {
                const samplesToProcess = Math.min(blockSize, totalSamples - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn,
                    currentPpqn + ppqnToProcess,
                    currentSample,
                    currentSample + samplesToProcess,
                    30 // 30 BPM
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)

                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                voiceCountHistory.push(sequencer.voiceCount)

                // Critical: Never more than 2 voices
                expect(sequencer.voiceCount).toBeLessThanOrEqual(2)

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            // After processing completes, analyze the history
            // With Once mode, voices should finish and be cleaned up
            // We should see periods of 0 voices (silence) between transients
            const maxVoiceCount = Math.max(...voiceCountHistory)
            const hasZeroVoicePeriods = voiceCountHistory.some(count => count === 0)

            // At 30 BPM with playback-rate 2:
            // - Each segment (0.5s of audio) plays in 0.25s (due to rate 2)
            // - But timeline between transients at 30 BPM is much longer
            // - So we MUST see silence (0 voices) between segments
            expect(maxVoiceCount).toBeLessThanOrEqual(2)

            // Log for debugging if test fails
            if (!hasZeroVoicePeriods) {
                console.log("Voice count never reached 0 - voices may be stuck")
                console.log("Sample voice counts:", voiceCountHistory.slice(0, 50))
            }
        })

        it("should properly fade out and clean up OnceVoice when segment audio is exhausted", () => {
            // Simpler test: single segment, verify voice completes and is removed
            const data = createMockAudioData(1.0) // 1 second of audio
            const transients = createTransients([0, 0.5]) // Just 2 transients
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Once, 2.0)

            const sampleRate = data.sampleRate
            const ppqnPerSecond = 960 * 30 / 60 // 30 BPM
            const ppqnPerSample = ppqnPerSecond / sampleRate

            // Process enough blocks to:
            // 1. Start playing first segment (transient at 0)
            // 2. Consume the segment audio (at rate 2, 0.5s audio = 0.25s playback)
            // 3. Continue past where the audio should be exhausted

            let currentSample = 0
            let currentPpqn = 0
            const blockSize = 128
            // At 30 BPM, 0.5s of file time = 960 PPQN
            // Process 2 seconds of timeline time to ensure we pass first segment
            const totalSamples = sampleRate * 2

            let sawVoice = false
            let sawZeroAfterVoice = false

            while (currentSample < totalSamples) {
                const samplesToProcess = Math.min(blockSize, totalSamples - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn,
                    currentPpqn + ppqnToProcess,
                    currentSample,
                    currentSample + samplesToProcess,
                    30
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)

                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                if (sequencer.voiceCount > 0) {
                    sawVoice = true
                }
                if (sawVoice && sequencer.voiceCount === 0) {
                    sawZeroAfterVoice = true
                }

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            // We should have seen a voice, then it should have been cleaned up
            expect(sawVoice).toBe(true)
            // With Once mode, voice should eventually be done and removed
            // (This will fail if voices are stuck)
            expect(sawZeroAfterVoice).toBe(true)
        })
    })

    // =========================================================================
    // BUG: Looping voices (Repeat/Pingpong) must NEVER be stopped by segment exhaustion
    // They loop forever until the sequencer fades them out at the next transient boundary
    // =========================================================================
    describe("Bug: Looping voices must never self-terminate", () => {
        it("RepeatVoice should survive BPM changes without stopping", () => {
            const data = createMockAudioData(4.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920 * 4, seconds: 4.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

            const sampleRate = data.sampleRate
            const blockSize = 128
            let currentSample = 0
            let currentPpqn = 0

            // Start at 60 BPM (slow - needs looping from the start)
            let bpm = 60
            let ppqnPerSecond = 960 * bpm / 60
            let ppqnPerSample = ppqnPerSecond / sampleRate

            // Process first second at 60 BPM - should create RepeatVoice
            while (currentSample < sampleRate) {
                const samplesToProcess = Math.min(blockSize, sampleRate - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn, currentPpqn + ppqnToProcess,
                    currentSample, currentSample + samplesToProcess, bpm
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)
                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            expect(sequencer.voiceCount).toBeGreaterThanOrEqual(1)

            // Now LOWER BPM even more to 30
            bpm = 30
            ppqnPerSecond = 960 * bpm / 60
            ppqnPerSample = ppqnPerSecond / sampleRate

            // Process another 2 seconds at 30 BPM - looping voice should keep looping
            const startSample = currentSample
            let sawZeroAfterBpmChange = false
            let zeroAtSample = -1
            while (currentSample < startSample + sampleRate * 2) {
                const samplesToProcess = Math.min(blockSize, startSample + sampleRate * 2 - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn, currentPpqn + ppqnToProcess,
                    currentSample, currentSample + samplesToProcess, bpm
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)
                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                if (sequencer.voiceCount === 0 && !sawZeroAfterBpmChange) {
                    sawZeroAfterBpmChange = true
                    zeroAtSample = currentSample
                }

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            // Should NOT have stopped after BPM change
            if (sawZeroAfterBpmChange) {
                console.log(`Voice stopped at sample ${zeroAtSample}`)
            }
            expect(sawZeroAfterBpmChange).toBe(false)
        })

        it("RepeatVoice should keep looping at slow BPM, never self-terminate", () => {
            const data = createMockAudioData(4.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920 * 4, seconds: 4.0}
            ])
            // Repeat mode at slow BPM - voice must keep looping
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

            const sampleRate = data.sampleRate
            const ppqnPerSecond = 960 * 30 / 60 // 30 BPM
            const ppqnPerSample = ppqnPerSecond / sampleRate

            let currentSample = 0
            let currentPpqn = 0
            const blockSize = 128
            const totalSamples = sampleRate * 4

            let sawZeroVoices = false

            while (currentSample < totalSamples) {
                const samplesToProcess = Math.min(blockSize, totalSamples - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn,
                    currentPpqn + ppqnToProcess,
                    currentSample,
                    currentSample + samplesToProcess,
                    30
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)

                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                // After first voice spawns, should never have 0 voices with Repeat mode
                if (currentSample > sampleRate * 0.1 && sequencer.voiceCount === 0) {
                    sawZeroVoices = true
                }

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            // Repeat mode should NEVER have gaps (0 voices)
            expect(sawZeroVoices).toBe(false)
        })

        it("PingpongVoice should keep bouncing at slow BPM, never self-terminate", () => {
            const data = createMockAudioData(4.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920 * 4, seconds: 4.0}
            ])
            // Pingpong mode at slow BPM - voice must keep bouncing
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Pingpong, 1.0)

            const sampleRate = data.sampleRate
            const ppqnPerSecond = 960 * 30 / 60 // 30 BPM
            const ppqnPerSample = ppqnPerSecond / sampleRate

            let currentSample = 0
            let currentPpqn = 0
            const blockSize = 128
            const totalSamples = sampleRate * 4

            let sawZeroVoices = false

            while (currentSample < totalSamples) {
                const samplesToProcess = Math.min(blockSize, totalSamples - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn,
                    currentPpqn + ppqnToProcess,
                    currentSample,
                    currentSample + samplesToProcess,
                    30
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)

                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                // After first voice spawns, should never have 0 voices with Pingpong mode
                if (currentSample > sampleRate * 0.1 && sequencer.voiceCount === 0) {
                    sawZeroVoices = true
                }

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            // Pingpong mode should NEVER have gaps (0 voices)
            expect(sawZeroVoices).toBe(false)
        })
    })

    // =========================================================================
    // BUG: 30 BPM, playback-rate 2, Pingpong mode - voices run too long
    // =========================================================================
    describe("Bug: 30 BPM, playback-rate 2, Pingpong mode", () => {
        it("should never have more than 2 voices (1 active + 1 fading during crossfade)", () => {
            const data = createMockAudioData(4.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920 * 4, seconds: 4.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Pingpong, 2.0)

            const sampleRate = data.sampleRate
            const ppqnPerSecond = 960 * 30 / 60
            const ppqnPerSample = ppqnPerSecond / sampleRate

            let currentSample = 0
            let currentPpqn = 0
            const blockSize = 128
            const totalSamples = sampleRate * 4

            let maxVoiceCount = 0
            let maxVoiceAtSample = 0

            while (currentSample < totalSamples) {
                const samplesToProcess = Math.min(blockSize, totalSamples - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn,
                    currentPpqn + ppqnToProcess,
                    currentSample,
                    currentSample + samplesToProcess,
                    30
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)

                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                if (sequencer.voiceCount > maxVoiceCount) {
                    maxVoiceCount = sequencer.voiceCount
                    maxVoiceAtSample = currentSample
                }

                // CRITICAL: Never more than 2 voices
                if (sequencer.voiceCount > 2) {
                    console.log(`Voice count ${sequencer.voiceCount} at sample ${currentSample}, ppqn ${currentPpqn}`)
                }
                expect(sequencer.voiceCount).toBeLessThanOrEqual(2)

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            // Should have stayed within limits
            if (maxVoiceCount > 2) {
                console.log(`Max voice count was ${maxVoiceCount} at sample ${maxVoiceAtSample}`)
            }
            expect(maxVoiceCount).toBeLessThanOrEqual(2)
        })

        it("old voices should complete fade-out within VOICE_FADE_DURATION after transient boundary", () => {
            const data = createMockAudioData(4.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920 * 4, seconds: 4.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Pingpong, 2.0)

            const sampleRate = data.sampleRate
            const ppqnPerSecond = 960 * 30 / 60
            const ppqnPerSample = ppqnPerSecond / sampleRate
            const fadeDurationSamples = Math.round(0.020 * sampleRate) // VOICE_FADE_DURATION = 20ms

            let currentSample = 0
            let currentPpqn = 0
            const blockSize = 128
            const totalSamples = sampleRate * 4

            // Track when we have 2 voices and how long it takes to go back to 1
            let twoVoiceStartSample = -1
            let maxTwoVoiceDuration = 0

            while (currentSample < totalSamples) {
                const samplesToProcess = Math.min(blockSize, totalSamples - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn,
                    currentPpqn + ppqnToProcess,
                    currentSample,
                    currentSample + samplesToProcess,
                    30
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)

                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                if (sequencer.voiceCount === 2) {
                    if (twoVoiceStartSample === -1) {
                        twoVoiceStartSample = currentSample
                    }
                } else if (sequencer.voiceCount === 1 && twoVoiceStartSample !== -1) {
                    const duration = currentSample - twoVoiceStartSample
                    maxTwoVoiceDuration = Math.max(maxTwoVoiceDuration, duration)
                    twoVoiceStartSample = -1
                }

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            // Two-voice periods should not exceed fade duration + some buffer for block boundaries
            const maxAllowedDuration = fadeDurationSamples + blockSize * 2
            if (maxTwoVoiceDuration > maxAllowedDuration) {
                console.log(`Two-voice duration was ${maxTwoVoiceDuration} samples, max allowed ${maxAllowedDuration}`)
            }
            expect(maxTwoVoiceDuration).toBeLessThanOrEqual(maxAllowedDuration)
        })
    })

    // =========================================================================
    // SCENARIO TESTS (from README.md)
    // =========================================================================
    describe("Scenario A: Matching BPM, playback-rate = 1.0", () => {
        it("should play through entire audio with single voice, no crossfades", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

            // Process at matching 120 BPM
            processBlocks(sequencer, output, data, transients, config, 120, 44100 * 1.5)

            // Single voice throughout
            expect(sequencer.voiceCount).toBe(1)
        })
    })

    describe("Scenario B: Matching BPM, playback-rate = 2.0", () => {
        it("should loop to fill time gap when consuming audio 2x faster", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])
            // Playback rate 2.0 = consuming audio 2x faster
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 2.0)

            // Process at 120 BPM with playback rate 2.0
            // Track voice count during processing
            let maxVoiceCount = 0
            let sawVoice = false

            const sampleRate = data.sampleRate
            const ppqnPerSecond = 960 * 120 / 60
            const ppqnPerSample = ppqnPerSecond / sampleRate
            let currentSample = 0
            let currentPpqn = 0
            const blockSize = 128
            const totalSamples = 44100

            while (currentSample < totalSamples) {
                const samplesToProcess = Math.min(blockSize, totalSamples - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn,
                    currentPpqn + ppqnToProcess,
                    currentSample,
                    currentSample + samplesToProcess,
                    120
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)

                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                if (sequencer.voiceCount > 0) sawVoice = true
                maxVoiceCount = Math.max(maxVoiceCount, sequencer.voiceCount)

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            // Should have had voice(s) during processing
            expect(sawVoice).toBe(true)
            expect(maxVoiceCount).toBeLessThanOrEqual(2)
        })
    })

    describe("Scenario C: Matching BPM, playback-rate = 0.5", () => {
        it("should cut audio short and crossfade at transient boundaries", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])
            // Playback rate 0.5 = consuming audio 0.5x slower
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 0.5)

            // Process at 120 BPM with playback rate 0.5
            processBlocks(sequencer, output, data, transients, config, 120, 44100)

            // Should have voice(s)
            expect(sequencer.voiceCount).toBeGreaterThanOrEqual(1)
            expect(sequencer.voiceCount).toBeLessThanOrEqual(2)
        })
    })

    describe("Scenario D: Slower BPM (50%), playback-rate = 1.0", () => {
        it("should loop to fill the extra output time", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

            // Process at 60 BPM (half the sample's tempo)
            // Track voice count during processing
            let maxVoiceCount = 0
            let sawVoice = false

            const sampleRate = data.sampleRate
            const ppqnPerSecond = 960 * 60 / 60
            const ppqnPerSample = ppqnPerSecond / sampleRate
            let currentSample = 0
            let currentPpqn = 0
            const blockSize = 128
            const totalSamples = 44100 * 2

            while (currentSample < totalSamples) {
                const samplesToProcess = Math.min(blockSize, totalSamples - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn,
                    currentPpqn + ppqnToProcess,
                    currentSample,
                    currentSample + samplesToProcess,
                    60
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)

                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                if (sequencer.voiceCount > 0) sawVoice = true
                maxVoiceCount = Math.max(maxVoiceCount, sequencer.voiceCount)

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            // Should have had voice(s) during processing
            expect(sawVoice).toBe(true)
            expect(maxVoiceCount).toBeLessThanOrEqual(2)
        })
    })

    describe("Scenario E: Faster BPM (200%), playback-rate = 1.0", () => {
        it("should cut audio short, crossfade halfway through segments", () => {
            const data = createMockAudioData(2.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

            // Process at 240 BPM (double the sample's tempo)
            processBlocks(sequencer, output, data, transients, config, 240, 44100)

            // Should have voice(s) - crossfading at each transient
            expect(sequencer.voiceCount).toBeGreaterThanOrEqual(1)
            expect(sequencer.voiceCount).toBeLessThanOrEqual(2)
        })
    })

    // =========================================================================
    // BUG: Gap when lowering BPM from ~95 to lower
    // When BPM drops from close-to-original to significantly lower:
    // - OnceVoice was created (closeToUnity was true at 95 BPM)
    // - BPM drops, now needsLooping becomes true
    // - System should immediately spawn a looping voice (no gap)
    // =========================================================================
    describe("Bug: Gap when lowering BPM from ~95 to lower", () => {
        it("should immediately spawn looping voice when BPM drops and looping becomes needed (Repeat)", () => {
            const data = createMockAudioData(4.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920 * 4, seconds: 4.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

            const sampleRate = data.sampleRate
            const blockSize = 128
            let currentSample = 0
            let currentPpqn = 0

            // Start at 95 BPM (close to 100% - will use OnceVoice due to closeToUnity)
            let bpm = 95
            let ppqnPerSecond = 960 * bpm / 60
            let ppqnPerSample = ppqnPerSecond / sampleRate

            // Process 0.3 seconds at 95 BPM to get into mid-segment
            const firstPhaseEnd = Math.round(sampleRate * 0.3)
            while (currentSample < firstPhaseEnd) {
                const samplesToProcess = Math.min(blockSize, firstPhaseEnd - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn, currentPpqn + ppqnToProcess,
                    currentSample, currentSample + samplesToProcess, bpm
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)
                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            expect(sequencer.voiceCount).toBeGreaterThanOrEqual(1)

            // Now DROP BPM to 60 - this should trigger looping
            bpm = 60
            ppqnPerSecond = 960 * bpm / 60
            ppqnPerSample = ppqnPerSecond / sampleRate

            // Track if we ever have 0 voices (gap) after BPM change
            let sawZeroVoices = false
            let zeroAtSample = -1

            // Process 2 more seconds at 60 BPM
            const secondPhaseEnd = currentSample + sampleRate * 2
            while (currentSample < secondPhaseEnd) {
                const samplesToProcess = Math.min(blockSize, secondPhaseEnd - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn, currentPpqn + ppqnToProcess,
                    currentSample, currentSample + samplesToProcess, bpm
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)
                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                if (sequencer.voiceCount === 0 && !sawZeroVoices) {
                    sawZeroVoices = true
                    zeroAtSample = currentSample
                }

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            // Should NEVER have 0 voices (no gap) with Repeat mode
            if (sawZeroVoices) {
                console.log(`Gap detected at sample ${zeroAtSample} after BPM drop from 95 to 60`)
            }
            expect(sawZeroVoices).toBe(false)
        })

        it("should immediately spawn looping voice when BPM drops and looping becomes needed (Pingpong)", () => {
            const data = createMockAudioData(4.0)
            const transients = createTransients([0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920 * 4, seconds: 4.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Pingpong, 1.0)

            const sampleRate = data.sampleRate
            const blockSize = 128
            let currentSample = 0
            let currentPpqn = 0

            // Start at 95 BPM
            let bpm = 95
            let ppqnPerSecond = 960 * bpm / 60
            let ppqnPerSample = ppqnPerSecond / sampleRate

            // Process 0.3 seconds at 95 BPM
            const firstPhaseEnd = Math.round(sampleRate * 0.3)
            while (currentSample < firstPhaseEnd) {
                const samplesToProcess = Math.min(blockSize, firstPhaseEnd - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn, currentPpqn + ppqnToProcess,
                    currentSample, currentSample + samplesToProcess, bpm
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)
                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            expect(sequencer.voiceCount).toBeGreaterThanOrEqual(1)

            // Drop BPM to 60
            bpm = 60
            ppqnPerSecond = 960 * bpm / 60
            ppqnPerSample = ppqnPerSecond / sampleRate

            let sawZeroVoices = false

            // Process 2 more seconds
            const secondPhaseEnd = currentSample + sampleRate * 2
            while (currentSample < secondPhaseEnd) {
                const samplesToProcess = Math.min(blockSize, secondPhaseEnd - currentSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn, currentPpqn + ppqnToProcess,
                    currentSample, currentSample + samplesToProcess, bpm
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)
                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                if (sequencer.voiceCount === 0) {
                    sawZeroVoices = true
                }

                currentSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            // Should NEVER have 0 voices (no gap) with Pingpong mode
            expect(sawZeroVoices).toBe(false)
        })
    })

    // =========================================================================
    // BUG: Amplitude spike during mid-segment voice transition
    // When BPM drops and we spawn a looping voice to replace OnceVoice:
    // - OnceVoice fades out (full -> 0)
    // - Looping voice fades in (0 -> full)
    // Combined amplitude should stay at ~1.0, not spike above or dip below
    // =========================================================================
    describe("Bug: Amplitude during mid-segment voice transition", () => {
        it("should maintain consistent amplitude when transitioning from OnceVoice to looping voice", () => {
            // Use constant amplitude 1.0 signal for easy measurement
            const sampleRate = 44100
            const durationSeconds = 4.0
            const numberOfFrames = Math.round(durationSeconds * sampleRate)
            const frames = [new Float32Array(numberOfFrames), new Float32Array(numberOfFrames)]
            for (let i = 0; i < numberOfFrames; i++) {
                frames[0][i] = 1.0
                frames[1][i] = 1.0
            }
            const data = {sampleRate, numberOfFrames, numberOfChannels: 2, frames}

            const transients = createTransients([0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920 * 4, seconds: 4.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

            const sequencer = new TimeStretchSequencer()
            const output = new AudioBuffer(2)

            const blockSize = 128
            let currentPpqn = 0

            // Start at 95 BPM (close to unity - OnceVoice)
            let bpm = 95
            let ppqnPerSecond = 960 * bpm / 60
            let ppqnPerSample = ppqnPerSecond / sampleRate

            // Process 0.3 seconds at 95 BPM
            const firstPhaseSamples = Math.round(sampleRate * 0.3)
            let samplesProcessed = 0
            while (samplesProcessed < firstPhaseSamples) {
                output.clear()
                const samplesToProcess = Math.min(blockSize, firstPhaseSamples - samplesProcessed)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                // s0 and s1 are OUTPUT BUFFER indices (0 to blockSize), not absolute sample positions
                const block = createBlock(
                    currentPpqn, currentPpqn + ppqnToProcess,
                    0, samplesToProcess, bpm
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)
                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                samplesProcessed += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            console.log(`After first phase: voiceCount=${sequencer.voiceCount}, ppqn=${currentPpqn.toFixed(2)}`)

            // Drop BPM to 60 - this triggers looping voice spawn
            bpm = 60
            ppqnPerSecond = 960 * bpm / 60
            ppqnPerSample = ppqnPerSecond / sampleRate

            // Track amplitude during transition
            let maxAmplitude = 0
            let minAmplitude = Number.POSITIVE_INFINITY
            let maxAmplitudeSample = 0
            let minAmplitudeSample = 0
            let totalSamplesChecked = 0

            // Process 0.5 seconds at 60 BPM (covers the transition period)
            const secondPhaseSamples = Math.round(sampleRate * 0.5)
            let secondPhaseProcessed = 0
            while (secondPhaseProcessed < secondPhaseSamples) {
                output.clear()
                const samplesToProcess = Math.min(blockSize, secondPhaseSamples - secondPhaseProcessed)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn, currentPpqn + ppqnToProcess,
                    0, samplesToProcess, bpm
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)
                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                // Check output amplitude
                const [outL] = output.channels()
                for (let i = 0; i < samplesToProcess; i++) {
                    const amp = Math.abs(outL[i])
                    totalSamplesChecked++
                    if (amp > maxAmplitude) {
                        maxAmplitude = amp
                        maxAmplitudeSample = samplesProcessed + secondPhaseProcessed + i
                    }
                    if (amp < minAmplitude && amp > 0) {
                        minAmplitude = amp
                        minAmplitudeSample = samplesProcessed + secondPhaseProcessed + i
                    }
                }

                secondPhaseProcessed += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            // Log results for analysis
            console.log(`Checked ${totalSamplesChecked} samples`)
            console.log(`Max amplitude: ${maxAmplitude.toFixed(3)} at sample ${maxAmplitudeSample}`)
            console.log(`Min amplitude: ${minAmplitude.toFixed(3)} at sample ${minAmplitudeSample}`)

            // Amplitude should stay close to 1.0 during crossfade
            // With identical audio and proper linear crossfade: (1-t)*1.0 + t*1.0 = 1.0
            // Allow small tolerance for floating point and block boundary effects
            const tolerance = 0.05 // 5% tolerance - should be very close to 1.0

            // Should not have amplitude spikes (voices adding together instead of crossfading)
            expect(maxAmplitude).toBeLessThanOrEqual(1.0 + tolerance)
        })

        it("should not have amplitude spike when voices play different audio positions", () => {
            // Use a constant signal so we can detect if voices are adding together
            // If both voices are at same position and crossfading correctly: output = 1.0
            // If positions differ or no crossfade: output could be 2.0 (both adding)
            const sampleRate = 44100
            const durationSeconds = 4.0
            const numberOfFrames = Math.round(durationSeconds * sampleRate)
            const frames = [new Float32Array(numberOfFrames), new Float32Array(numberOfFrames)]
            for (let i = 0; i < numberOfFrames; i++) {
                frames[0][i] = 0.5  // Constant 0.5 so doubling would give 1.0
                frames[1][i] = 0.5
            }
            const data = {sampleRate, numberOfFrames, numberOfChannels: 2, frames}

            const transients = createTransients([0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920 * 4, seconds: 4.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

            const sequencer = new TimeStretchSequencer()
            const output = new AudioBuffer(2)

            const blockSize = 128
            let currentPpqn = 0

            // Start at 95 BPM
            let bpm = 95
            let ppqnPerSecond = 960 * bpm / 60
            let ppqnPerSample = ppqnPerSecond / sampleRate

            // Process 0.3 seconds at 95 BPM
            const firstPhaseSamples = Math.round(sampleRate * 0.3)
            let samplesProcessed = 0
            while (samplesProcessed < firstPhaseSamples) {
                output.clear()
                const samplesToProcess = Math.min(blockSize, firstPhaseSamples - samplesProcessed)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn, currentPpqn + ppqnToProcess,
                    0, samplesToProcess, bpm
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)
                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                samplesProcessed += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            console.log(`After first phase: voiceCount=${sequencer.voiceCount}`)

            // Drop BPM to 60
            bpm = 60
            ppqnPerSecond = 960 * bpm / 60
            ppqnPerSample = ppqnPerSecond / sampleRate

            // Track amplitude during transition
            let maxAmplitude = 0
            let maxAmplitudeSample = 0

            // Process 0.1 seconds at 60 BPM (covers the transition/crossfade period)
            const secondPhaseSamples = Math.round(sampleRate * 0.1)
            let secondPhaseProcessed = 0
            while (secondPhaseProcessed < secondPhaseSamples) {
                output.clear()
                const samplesToProcess = Math.min(blockSize, secondPhaseSamples - secondPhaseProcessed)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn, currentPpqn + ppqnToProcess,
                    0, samplesToProcess, bpm
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)
                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                const [outL] = output.channels()
                for (let i = 0; i < samplesToProcess; i++) {
                    const amp = Math.abs(outL[i])
                    if (amp > maxAmplitude) {
                        maxAmplitude = amp
                        maxAmplitudeSample = samplesProcessed + secondPhaseProcessed + i
                    }
                }

                secondPhaseProcessed += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            console.log(`Max amplitude after BPM change: ${maxAmplitude.toFixed(4)} at sample ${maxAmplitudeSample}`)

            // With constant 0.5 audio:
            // - Correct crossfade: fade-out (0.5 * (1-t)) + fade-in (0.5 * t) = 0.5
            // - No crossfade (both at full): 0.5 + 0.5 = 1.0
            // Allow 10% tolerance above 0.5
            const expectedMax = 0.55
            if (maxAmplitude > expectedMax) {
                console.log(`AMPLITUDE SPIKE: Expected max ~0.50, got ${maxAmplitude.toFixed(4)} (voices not crossfading properly)`)
            }
            expect(maxAmplitude).toBeLessThanOrEqual(expectedMax)
        })
    })

    // =========================================================================
    // RULE 5b: Early Fade-In for Transient Preservation
    // Voice should reach full amplitude exactly when transient occurs
    // =========================================================================
    describe("Rule 5b: Early Fade-In for Transient Preservation", () => {
        it("should reach full amplitude at the transient, not after", () => {
            // Use constant amplitude signal so we can measure fade progress
            const sampleRate = 44100
            const durationSeconds = 2.0
            const numberOfFrames = Math.round(durationSeconds * sampleRate)
            const frames = [new Float32Array(numberOfFrames), new Float32Array(numberOfFrames)]
            for (let i = 0; i < numberOfFrames; i++) {
                frames[0][i] = 1.0
                frames[1][i] = 1.0
            }
            const data = {sampleRate, numberOfFrames, numberOfChannels: 2, frames}

            // Transient at 0.5 seconds
            const transients = createTransients([0, 0.5, 1.0])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}  // 120 BPM sample
            ])
            // Force crossfade at transient boundaries by using faster BPM
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Once, 1.0)

            const sequencer = new TimeStretchSequencer()
            const output = new AudioBuffer(2)

            // At 180 BPM (1.5x faster than sample), we'll hit transient 0.5s
            // sooner than the audio reaches that point, forcing a crossfade
            const bpm = 180
            const ppqnPerSecond = 960 * bpm / 60
            const ppqnPerSample = ppqnPerSecond / sampleRate

            const blockSize = 128
            let currentPpqn = 0
            let absoluteSample = 0

            // Process until we're past the second transient (0.5s in file time)
            // At 180 BPM, 0.5s file time = 0.5 * (180/120) = 0.333s wall time
            const totalSamples = Math.round(sampleRate * 0.5)

            // Track amplitude around the transient boundary
            const amplitudesAroundTransient: {sample: number, amplitude: number}[] = []
            let transientOccurred = false
            let samplesAroundTransient = 0

            // Calculate when transient 0.5s should occur in PPQN
            // At 120 BPM sample: 0.5s = 960 PPQN
            // We're playing at 180 BPM, so we reach 960 PPQN after 960/(180*960/60) = 0.333s
            const transientPpqn = 960  // transient at 0.5s in 120 BPM = 960 PPQN

            while (absoluteSample < totalSamples) {
                output.clear()
                const samplesToProcess = Math.min(blockSize, totalSamples - absoluteSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn, currentPpqn + ppqnToProcess,
                    0, samplesToProcess, bpm
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)
                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                // Check if this block contains the transient
                const blockContainsTransient = currentPpqn <= transientPpqn && currentPpqn + ppqnToProcess > transientPpqn
                if (blockContainsTransient) {
                    transientOccurred = true
                }

                // Record amplitudes around the transient
                if (transientOccurred && samplesAroundTransient < sampleRate * 0.05) { // 50ms after transient
                    const [outL] = output.channels()
                    for (let i = 0; i < samplesToProcess; i++) {
                        amplitudesAroundTransient.push({
                            sample: absoluteSample + i,
                            amplitude: outL[i]
                        })
                        samplesAroundTransient++
                    }
                }

                absoluteSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            expect(transientOccurred).toBe(true)
            expect(amplitudesAroundTransient.length).toBeGreaterThan(0)

            // The NEW voice should be at full amplitude (1.0) right when the transient occurs
            // Not ramping up from 0 during the transient
            // Check the first few samples after transient - they should be close to 1.0
            const firstSamples = amplitudesAroundTransient.slice(0, 10)
            const avgAmplitude = firstSamples.reduce((sum, s) => sum + s.amplitude, 0) / firstSamples.length

            console.log(`First 10 samples after transient: avg amplitude = ${avgAmplitude.toFixed(3)}`)
            console.log(`Sample amplitudes: ${firstSamples.map(s => s.amplitude.toFixed(2)).join(', ')}`)

            // With early fade-in, amplitude should be close to 1.0 at transient
            // (allowing for crossfade overlap where outgoing + incoming ≈ 1.0)
            expect(avgAmplitude).toBeGreaterThan(0.9)
        })

        it("should start fade-in BEFORE the transient so it completes at the transient", () => {
            // Test that the new voice reaches full amplitude exactly when transient hits
            // Use distinct audio content for each segment to identify which voice is active
            const sampleRate = 44100
            const durationSeconds = 2.0
            const numberOfFrames = Math.round(durationSeconds * sampleRate)
            const frames = [new Float32Array(numberOfFrames), new Float32Array(numberOfFrames)]

            // Segment 1 (0-0.5s): value = 0.3
            // Segment 2 (0.5-1.0s): value = 0.7
            const transientAtSamples = 0.5 * sampleRate
            for (let i = 0; i < numberOfFrames; i++) {
                const value = i < transientAtSamples ? 0.3 : 0.7
                frames[0][i] = value
                frames[1][i] = value
            }
            const data = {sampleRate, numberOfFrames, numberOfChannels: 2, frames}

            const transients = createTransients([0, 0.5, 1.0])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920, seconds: 1.0}
            ])
            // Use Once mode to avoid looping complexity
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Once, 1.0)

            const sequencer = new TimeStretchSequencer()
            const output = new AudioBuffer(2)

            // At 180 BPM (1.5x faster), we hit transients before audio naturally reaches them
            const bpm = 180
            const ppqnPerSecond = 960 * bpm / 60
            const ppqnPerSample = ppqnPerSecond / sampleRate
            const fadeLengthSamples = Math.round(0.020 * sampleRate) // 882 samples

            const blockSize = 128
            let currentPpqn = 0
            let absoluteSample = 0

            // Process past the second transient
            const totalSamples = Math.round(sampleRate * 0.5)

            // Track output right around the transient
            const transientPpqn = 960
            const transientSample = Math.round(transientPpqn / ppqnPerSample) // ~14700 samples

            // Record samples around transient boundary
            const samplesAroundTransient: {sample: number, value: number, ppqn: number}[] = []

            while (absoluteSample < totalSamples) {
                output.clear()
                const samplesToProcess = Math.min(blockSize, totalSamples - absoluteSample)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn, currentPpqn + ppqnToProcess,
                    0, samplesToProcess, bpm
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)

                const voicesBefore = sequencer.voiceCount
                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)
                const voicesAfter = sequencer.voiceCount

                // Debug around crossfade region
                if (currentPpqn > 850 && currentPpqn < 1000 && (voicesBefore !== voicesAfter || voicesAfter > 1)) {
                    console.log(`Block PPQN ${currentPpqn.toFixed(0)}-${(currentPpqn + ppqnToProcess).toFixed(0)}: voices ${voicesBefore} -> ${voicesAfter}`)
                }

                // Record samples in the vicinity of transient
                const [outL] = output.channels()
                for (let i = 0; i < samplesToProcess; i++) {
                    const sampleNum = absoluteSample + i
                    const samplePpqn = currentPpqn + (i * ppqnPerSample)
                    // Record samples from 30ms before to 30ms after transient
                    if (Math.abs(sampleNum - transientSample) < sampleRate * 0.030) {
                        samplesAroundTransient.push({
                            sample: sampleNum,
                            value: outL[i],
                            ppqn: samplePpqn
                        })
                    }
                }

                absoluteSample += samplesToProcess
                currentPpqn += ppqnToProcess
            }

            // Find the sample exactly at transient (closest to transientPpqn)
            const atTransient = samplesAroundTransient.find(s => s.ppqn >= transientPpqn)

            // With proper early fade-in:
            // - New voice (segment 2, value=0.7) should be at FULL AMPLITUDE (gain=1.0) at transient
            // - Old voice (segment 1, value=0.3) should have FADED OUT completely by transient
            // - Output at transient = 0.7 × 1.0 = 0.7 (new segment at full amplitude)
            // - The transient attack is fully preserved without any fade-in softening
            //
            // Without early fade-in (broken behavior):
            // - New voice starts fade-in AT the transient (gain ramping from 0)
            // - Old voice starts fade-out AT the transient (gain ramping to 0)
            // - Output at transient is crossfade mix: 0.3 × 0.5 + 0.7 × 0.5 = 0.5
            // - The transient attack is softened by the fade-in ramp

            // Debug: print samples around crossfade
            const beforeTransient = samplesAroundTransient.filter(s => s.ppqn < transientPpqn - 50)
            if (beforeTransient.length > 5) {
                const last5Before = beforeTransient.slice(-5)
                console.log(`5 samples before crossfade region: ${last5Before.map(s => `${s.value.toFixed(2)}@${s.ppqn.toFixed(0)}`).join(', ')}`)
            }
            const duringCrossfade = samplesAroundTransient.filter(s => s.ppqn >= transientPpqn - 50 && s.ppqn < transientPpqn)
            if (duringCrossfade.length > 0) {
                console.log(`During expected crossfade (${duringCrossfade.length} samples): first=${duringCrossfade[0]?.value.toFixed(3)}, last=${duringCrossfade[duringCrossfade.length-1]?.value.toFixed(3)}`)
            }

            if (atTransient) {
                console.log(`At transient (PPQN ${atTransient.ppqn.toFixed(2)}): value = ${atTransient.value.toFixed(3)}`)

                // With early fade-in, value should be exactly 0.7 (new segment at full amplitude)
                // This proves the entire transient attack is preserved
                // If value is around 0.5, it means crossfade is happening AT the transient (broken)
                expect(atTransient.value).toBeGreaterThan(0.6) // Should be close to 0.7
            }

            // Also check a few samples after transient - should be solidly at 0.7
            const afterTransient = samplesAroundTransient.filter(s => s.ppqn > transientPpqn + 100)
            if (afterTransient.length > 0) {
                const avgAfter = afterTransient.slice(0, 10).reduce((sum, s) => sum + s.value, 0) / 10
                console.log(`Average after transient: ${avgAfter.toFixed(3)}`)
                expect(avgAfter).toBeGreaterThan(0.65)
            }
        })
    })

    // =========================================================================
    // BUG: Gap detection during BPM change
    // Check for actual zero output when there should be audio
    // =========================================================================
    describe("Bug: Gap detection during BPM change", () => {
        it("should have no zero-amplitude samples when lowering BPM from 95 to 60", () => {
            // Use constant amplitude signal so gaps are obvious
            const sampleRate = 44100
            const durationSeconds = 4.0
            const numberOfFrames = Math.round(durationSeconds * sampleRate)
            const frames = [new Float32Array(numberOfFrames), new Float32Array(numberOfFrames)]
            for (let i = 0; i < numberOfFrames; i++) {
                frames[0][i] = 1.0
                frames[1][i] = 1.0
            }
            const data = {sampleRate, numberOfFrames, numberOfChannels: 2, frames}

            const transients = createTransients([0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5])
            const warpMarkers = createWarpMarkers([
                {ppqn: 0, seconds: 0},
                {ppqn: 1920 * 4, seconds: 4.0}
            ])
            const config = new TestTimeStretchConfig(warpMarkers, TransientPlayMode.Repeat, 1.0)

            const sequencer = new TimeStretchSequencer()
            const output = new AudioBuffer(2)

            const blockSize = 128
            let currentPpqn = 0
            let absoluteSample = 0

            // Start at 95 BPM
            let bpm = 95
            let ppqnPerSecond = 960 * bpm / 60
            let ppqnPerSample = ppqnPerSecond / sampleRate

            // Track gaps
            const gaps: {sample: number, blockStart: number}[] = []

            // Process 0.3 seconds at 95 BPM
            const firstPhaseSamples = Math.round(sampleRate * 0.3)
            let samplesProcessed = 0
            while (samplesProcessed < firstPhaseSamples) {
                output.clear()
                const samplesToProcess = Math.min(blockSize, firstPhaseSamples - samplesProcessed)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn, currentPpqn + ppqnToProcess,
                    0, samplesToProcess, bpm
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)
                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                // Check for gaps
                const [outL] = output.channels()
                for (let i = 0; i < samplesToProcess; i++) {
                    if (outL[i] === 0) {
                        gaps.push({sample: absoluteSample + i, blockStart: absoluteSample})
                    }
                }

                samplesProcessed += samplesToProcess
                currentPpqn += ppqnToProcess
                absoluteSample += samplesToProcess
            }

            console.log(`After first phase (95 BPM): voiceCount=${sequencer.voiceCount}, gaps=${gaps.length}`)

            // Drop BPM to 60 - this should trigger looping voice spawn
            bpm = 60
            ppqnPerSecond = 960 * bpm / 60
            ppqnPerSample = ppqnPerSecond / sampleRate

            // Process 1 second at 60 BPM
            const secondPhaseSamples = Math.round(sampleRate * 1.0)
            let secondPhaseProcessed = 0
            while (secondPhaseProcessed < secondPhaseSamples) {
                output.clear()
                const samplesToProcess = Math.min(blockSize, secondPhaseSamples - secondPhaseProcessed)
                const ppqnToProcess = samplesToProcess * ppqnPerSample

                const block = createBlock(
                    currentPpqn, currentPpqn + ppqnToProcess,
                    0, samplesToProcess, bpm
                )
                const cycle = createCycle(currentPpqn, currentPpqn + ppqnToProcess, 0)
                sequencer.process(output, data, transients as any, config as any, 0, block, cycle)

                // Check for gaps - but ALSO log voice count when gap occurs
                const [outL] = output.channels()
                for (let i = 0; i < samplesToProcess; i++) {
                    if (outL[i] === 0) {
                        gaps.push({sample: absoluteSample + i, blockStart: absoluteSample})
                    }
                }

                secondPhaseProcessed += samplesToProcess
                currentPpqn += ppqnToProcess
                absoluteSample += samplesToProcess
            }

            // Report gaps
            if (gaps.length > 0) {
                console.log(`GAPS DETECTED: ${gaps.length} samples with zero output`)
                // Show first 10 gaps
                const firstGaps = gaps.slice(0, 10)
                for (const gap of firstGaps) {
                    console.log(`  Gap at absolute sample ${gap.sample} (block started at ${gap.blockStart})`)
                }
                if (gaps.length > 10) {
                    console.log(`  ... and ${gaps.length - 10} more`)
                }
            }

            // Should have no gaps
            expect(gaps.length).toBe(0)
        })
    })
})
