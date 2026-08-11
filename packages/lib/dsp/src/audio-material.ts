import {AudioData} from "./audio-data"

// One analyzed transient segment: the subset of `stretch::TransientDescriptor` (crates/stretch,
// descriptor.rs) the material classification reads.
export interface AudioMaterialSegment {
    readonly position: number      // onset in SECONDS
    readonly strength: number      // [0,1] attack sharpness (~1 drum hit, ~0 pad swell)
    readonly period: number        // fundamental period in SAMPLES, 0 = aperiodic
    readonly harmonicity: number   // [0,1] tonality from spectral flatness
    readonly rms: number           // segment RMS (linear)
}

// Measured description of imported material, aimed at the pad-vs-drum-loop decision (which stretch
// algorithm suits it). Every field except `drumLoopProbability` is a measurement: consumers that
// distrust our heuristic can weigh the features themselves.
export interface AudioMaterialFeatures {
    readonly durationSeconds: number
    readonly onsetCount: number
    readonly onsetsPerSecond: number      // transient density
    readonly strengthMean: number         // 0..1 attack sharpness
    readonly strengthMedian: number
    readonly harmonicityMean: number      // 0..1 tonality (spectral flatness)
    readonly harmonicityMedian: number
    readonly pitchedFraction: number      // fraction of segments with period > 0
    readonly percussiveFraction: number   // strong attack and low harmonicity
    readonly beatRegularity: number       // 0..1 from inter-onset-interval consistency
    readonly rms: number                  // overall linear RMS
    readonly drumLoopProbability: number  // 0..1 HEURISTIC, documented and replaceable
    readonly analyzerVersion: number      // from analyzer_version(), for cache invalidation
}

export interface AudioMaterialProtocol {
    // The module url travels with the call for the same reason it does in `BpmProtocol`: the first
    // call compiles the analyzer, later calls reuse the instance cached under that url.
    analyze(audioData: AudioData, moduleUrl: string): Promise<AudioMaterialFeatures>
}

export namespace AudioMaterial {
    // DRAFT constants. The plan (plans/riffle-material-classifier.md) calls for fitting these on a
    // labeled corpus with the crates/stretch-lab harness; until then they are hand-set and the
    // probability must be read as a hint, not a verdict.
    export const SILENCE_RMS = 0.001        // -60 dBFS, segments below this describe nothing
    export const STRONG_ATTACK = 0.6
    export const NOISY_HARMONICITY = 0.4
    export const DENSITY_REF = 4.0          // onsets per second that reads as fully rhythmic
    export const REGULARITY_INTERVALS = 4   // intervals needed before a grid is fully believed

    // Logistic weights over the terms below, all of which are 0..1. Inharmonicity carries most of the
    // weight because it is the only term measured on real material that separates the two classes: a
    // drum loop reads harmonicity ~0.6, a pad ~1.0. Onset density and grid regularity support it but do
    // not decide, since a moving pad also fires onsets several times a second.
    // `pitchedFraction` is deliberately UNWEIGHTED: the analyzer's YIN period is 0 for most segments of
    // sustained material too (a pad measured 17% pitched against a drum loop's 19%), so the fraction
    // carries no signal here. It stays in the features for consumers that can use it.
    export const WEIGHT_BIAS = -4.0
    export const WEIGHT_DENSITY = 1.5
    export const WEIGHT_STRENGTH = 1.0
    export const WEIGHT_INHARMONIC = 8.0
    export const WEIGHT_REGULARITY = 1.0

    const mean = (values: ReadonlyArray<number>): number =>
        values.length === 0 ? 0.0 : values.reduce((sum, value) => sum + value, 0.0) / values.length

    const median = (values: ReadonlyArray<number>): number => {
        if (values.length === 0) {return 0.0}
        const sorted = values.slice().sort((a, b) => a - b)
        const center = sorted.length >> 1
        return sorted.length % 2 === 1 ? sorted[center] : (sorted[center - 1] + sorted[center]) * 0.5
    }

    // Inter-onset-interval consistency: a drum loop keeps a near-constant grid, so its coefficient of
    // variation is small and regularity approaches 1. Fewer than three onsets span fewer than two
    // intervals, which cannot show consistency at all, hence 0. Two or three intervals are weak
    // evidence of a grid (a pad with three swells scores a deceptively high CV term), so the result is
    // scaled by how many intervals actually back it.
    export const beatRegularity = (positions: ReadonlyArray<number>): number => {
        if (positions.length < 3) {return 0.0}
        const intervals = positions.slice(1).map((position, index) => position - positions[index])
        const average = mean(intervals)
        if (average <= 0.0) {return 0.0}
        const variance = mean(intervals.map(interval => (interval - average) ** 2))
        const confidence = Math.min(1.0, intervals.length / REGULARITY_INTERVALS)
        return confidence / (1.0 + Math.sqrt(variance) / average)
    }

    export const rmsOf = (audioData: AudioData): number => {
        const {frames, numberOfFrames, numberOfChannels} = audioData
        if (numberOfFrames === 0 || numberOfChannels === 0) {return 0.0}
        let sum = 0.0
        for (let channel = 0; channel < numberOfChannels; channel++) {
            const values = frames[channel]
            for (let index = 0; index < numberOfFrames; index++) {sum += values[index] ** 2}
        }
        return Math.sqrt(sum / (numberOfFrames * numberOfChannels))
    }

    // z = bias + weighted terms, squashed. Documented as a heuristic on purpose: the features above
    // are the contract, this number is a convenience over them. Note `strengthMedian` contributes
    // almost nothing on steady material: the analyzer derives strength from onset exceedance over a
    // LOCAL median, so every hit in a dense loop reads ~0. Attack sharpness needs a different measure
    // before it can carry weight here.
    export const drumLoopProbability = (features: Omit<AudioMaterialFeatures, "drumLoopProbability">): number => {
        const density = Math.min(1.0, features.onsetsPerSecond / DENSITY_REF)
        const z = WEIGHT_BIAS
            + WEIGHT_DENSITY * density
            + WEIGHT_STRENGTH * features.strengthMedian
            + WEIGHT_INHARMONIC * (1.0 - features.harmonicityMedian)
            + WEIGHT_REGULARITY * features.beatRegularity
        return 1.0 / (1.0 + Math.exp(-z))
    }

    // Segments below SILENCE_RMS describe silence, not material, so they are dropped before any
    // average. Onset density still counts every detected onset: a gap between hits is part of the
    // rhythm, not a segment to ignore.
    export const aggregate = (segments: ReadonlyArray<AudioMaterialSegment>,
                              durationSeconds: number,
                              rms: number,
                              analyzerVersion: number): AudioMaterialFeatures => {
        const gated = segments.filter(segment => segment.rms >= SILENCE_RMS)
        const strengths = gated.map(segment => segment.strength)
        const harmonicities = gated.map(segment => segment.harmonicity)
        const count = gated.length
        const measured = {
            durationSeconds,
            onsetCount: segments.length,
            onsetsPerSecond: durationSeconds > 0.0 ? segments.length / durationSeconds : 0.0,
            strengthMean: mean(strengths),
            strengthMedian: median(strengths),
            harmonicityMean: mean(harmonicities),
            harmonicityMedian: median(harmonicities),
            pitchedFraction: count === 0 ? 0.0 : gated.filter(segment => segment.period > 0.0).length / count,
            percussiveFraction: count === 0 ? 0.0 : gated.filter(segment =>
                segment.strength >= STRONG_ATTACK && segment.harmonicity <= NOISY_HARMONICITY).length / count,
            beatRegularity: beatRegularity(segments.map(segment => segment.position)),
            rms,
            analyzerVersion
        } satisfies Omit<AudioMaterialFeatures, "drumLoopProbability">
        return {...measured, drumLoopProbability: drumLoopProbability(measured)}
    }
}
