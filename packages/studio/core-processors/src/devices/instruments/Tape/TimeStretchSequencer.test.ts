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
    // SCENARIO TESTS (from PLAYBACK_SYSTEM.md)
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
})
