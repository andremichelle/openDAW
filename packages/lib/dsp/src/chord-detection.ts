import {int, isDefined, Nullable, Option} from "@opendaw/lib-std"
import {Harmony} from "./harmony"
import {ppqn} from "./ppqn"

export namespace ChordDetection {
    // bits: the chord as a mask of semitones above its root (one octave), bass: the pitch class of the lowest note
    export type Detected = { readonly root: int, readonly bits: int, readonly bass: int }
    export type Step = {
        readonly degree: int, readonly shift: int, readonly shape: int, readonly notes: int, readonly inversion: int
    }
    export type Note = { readonly position: ppqn, readonly duration: ppqn, readonly pitch: int }
    export type Segment = { readonly position: ppqn, readonly duration: ppqn, readonly chord: Detected }

    const mask = (...intervals: ReadonlyArray<int>): int => intervals.reduce((bits, interval) => bits | (1 << interval), 0)

    // simpler chords first, so they win a tie
    const Templates: ReadonlyArray<int> = [
        mask(0, 4, 7), mask(0, 3, 7), mask(0, 3, 6), mask(0, 4, 8), mask(0, 2, 7), mask(0, 5, 7),
        mask(0, 4, 7, 10), mask(0, 4, 7, 11), mask(0, 3, 7, 10), mask(0, 3, 6, 10), mask(0, 3, 6, 9)
    ]
    const PresentThreshold = 0.25
    const NaturalMinorBits: int = 0b010110101101
    // Krumhansl-Kessler key profiles
    const MajorProfile: ReadonlyArray<number> = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
    const MinorProfile: ReadonlyArray<number> = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

    const countBits = (bits: int): int => {
        let count = 0
        for (let index = 0; index < 12; index++) {if ((bits & (1 << index)) !== 0) {count++}}
        return count
    }

    export const detectChord = (weights: ArrayLike<number>, bass: int): Option<Detected> => {
        let max = 0
        for (let pitchClass = 0; pitchClass < 12; pitchClass++) {max = Math.max(max, weights[pitchClass])}
        if (max <= 0) {return Option.None}
        let present = 0
        for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
            if (weights[pitchClass] >= max * PresentThreshold) {present |= 1 << pitchClass}
        }
        if (countBits(present) < 3) {return Option.None}
        const bassClass = ((bass % 12) + 12) % 12
        let best: Nullable<{ root: int, bits: int }> = null
        let bestScore = Number.NEGATIVE_INFINITY
        for (let root = 0; root < 12; root++) {
            for (const bits of Templates) {
                let matched = 0, extra = 0, omittedFifth = false, rejected = false
                for (let interval = 0; interval < 12 && !rejected; interval++) {
                    const pitchClass = (root + interval) % 12
                    const inTemplate = (bits & (1 << interval)) !== 0
                    const inSet = (present & (1 << pitchClass)) !== 0
                    if (inTemplate && inSet) {
                        matched += weights[pitchClass]
                    } else if (inTemplate) {
                        if (interval === 7 && countBits(bits) === 4) {omittedFifth = true} else {rejected = true}
                    } else if (inSet) {
                        extra += weights[pitchClass]
                    }
                }
                if (rejected) {continue}
                const score = matched - extra - (omittedFifth ? max * 0.1 : 0) + (root === bassClass ? max * 0.05 : 0)
                if (score > bestScore) {
                    best = {root, bits}
                    bestScore = score
                }
            }
        }
        return isDefined(best) ? Option.wrap({root: best.root, bits: best.bits, bass: bassClass}) : Option.None
    }

    const correlate = (weights: ArrayLike<number>, profile: ReadonlyArray<number>, root: int): number => {
        let meanWeight = 0, meanProfile = 0
        for (let index = 0; index < 12; index++) {
            meanWeight += weights[index] / 12
            meanProfile += profile[index] / 12
        }
        let covariance = 0, varianceWeight = 0, varianceProfile = 0
        for (let index = 0; index < 12; index++) {
            const weight = weights[(root + index) % 12] - meanWeight
            const value = profile[index] - meanProfile
            covariance += weight * value
            varianceWeight += weight * weight
            varianceProfile += value * value
        }
        return varianceWeight === 0 ? 0 : covariance / Math.sqrt(varianceWeight * varianceProfile)
    }

    export const detectKey = (weights: ArrayLike<number>): Option<Harmony.Key> => {
        let best: Nullable<Harmony.Key> = null
        let bestScore = 0
        for (let root = 0; root < 12; root++) {
            for (const [profile, bits] of [[MajorProfile, Harmony.MajorBits], [MinorProfile, NaturalMinorBits]] as const) {
                const score = correlate(weights, profile, root)
                if (score > bestScore) {
                    best = {root, bits}
                    bestScore = score
                }
            }
        }
        return Option.wrap(best)
    }

    const octaveMask = (stack: ReadonlyArray<int>): int => stack.reduce((bits, interval) => bits | (1 << (interval % 12)), 0)

    const inversionOf = (stack: ReadonlyArray<int>, root: int, bass: int): int =>
        Math.max(0, stack.findIndex(interval => interval % 12 === ((bass - root) % 12 + 12) % 12))

    // a detected chord as a step of the key: the plain scale chord where it matches, else the step's root with a shape
    export const toStep = (key: Harmony.Key, {root, bits, bass}: Detected): Option<Step> => {
        for (const shift of [0, -1, 1]) {
            for (let degree = 1; degree <= 7; degree++) {
                const triad = Harmony.chord(key, degree, shift, 0, 3)
                if (triad.isEmpty() || triad.unwrap().root !== root) {continue}
                if (shift === 0) {
                    for (let notes = 3; notes <= 5; notes++) {
                        const {stack} = Harmony.chord(key, degree, 0, 0, notes).unwrap()
                        if (octaveMask(stack) === bits) {
                            return Option.wrap({degree, shift, shape: 0, notes, inversion: inversionOf(stack, root, bass)})
                        }
                    }
                }
                const stack: Array<int> = []
                for (let interval = 0; interval < 12; interval++) {if ((bits & (1 << interval)) !== 0) {stack.push(interval)}}
                return Option.wrap({degree, shift, shape: bits, notes: 3, inversion: inversionOf(stack, root, bass)})
            }
        }
        return Option.None
    }

    export const pitchClassWeights = (notes: ReadonlyArray<Note>, from: ppqn, to: ppqn): Float64Array => {
        const weights = new Float64Array(12)
        for (const {position, duration, pitch} of notes) {
            const overlap = Math.min(position + duration, to) - Math.max(position, from)
            if (overlap > 0) {weights[pitch % 12] += overlap}
        }
        return weights
    }

    // onsets closer than this count as one chord change (a strummed or humanised chord)
    const OnsetTolerance: ppqn = 120
    // a stretch with too few notes for a chord (an arpeggio) collects the following onsets up to this length
    const MaxCollect: ppqn = 3840

    const detectIn = (notes: ReadonlyArray<Note>, from: ppqn, to: ppqn): Option<Detected> => {
        const sounding = notes.filter(note => note.position < to && note.position + note.duration > from)
        if (sounding.length === 0) {return Option.None}
        return detectChord(pitchClassWeights(sounding, from, to), Math.min(...sounding.map(note => note.pitch)))
    }

    const pitchClassesIn = (notes: ReadonlyArray<Note>, from: ppqn, to: ppqn): int => notes
        .filter(note => note.position < to && note.position + note.duration > from)
        .reduce((bits, {pitch}) => bits | (1 << (pitch % 12)), 0)

    const pitchClassesOf = ({root, bits}: Detected): int => {
        let classes = 0
        for (let interval = 0; interval < 12; interval++) {if ((bits & (1 << interval)) !== 0) {classes |= 1 << ((root + interval) % 12)}}
        return classes
    }

    // a chord starts where its notes start and lasts until the next chord, equal neighbours merge
    export const segment = (notes: ReadonlyArray<Note>, from: ppqn, to: ppqn): ReadonlyArray<Segment> => {
        const starts: Array<ppqn> = []
        notes.map(({position}) => position).filter(position => position >= from && position < to)
            .sort((a, b) => a - b)
            .forEach(position => {
                const last = starts.at(-1)
                if (!isDefined(last) || position - last > OnsetTolerance) {starts.push(position)}
            })
        const found: Array<{ position: ppqn, chord: Detected }> = []
        let index = 0
        while (index < starts.length) {
            const position = starts[index]
            let next = index + 1
            const end = next < starts.length ? starts[next] : to
            let chord = detectIn(notes, position, end)
            const previous = found.at(-1)
            if (chord.isEmpty() && isDefined(previous)) {
                const classes = pitchClassesIn(notes, position, end)
                if ((classes & pitchClassesOf(previous.chord)) === classes) {
                    index = next
                    continue
                }
            }
            while (chord.isEmpty() && next < starts.length && starts[next] - position < MaxCollect) {
                next++
                chord = detectIn(notes, position, next < starts.length ? starts[next] : to)
            }
            chord.ifSome(chord => {
                const last = found.at(-1)
                if (!isDefined(last) || last.chord.root !== chord.root || last.chord.bits !== chord.bits
                    || last.chord.bass !== chord.bass) {found.push({position, chord})}
            })
            index = next
        }
        return found.map(({position, chord}, index) =>
            ({position, duration: (index + 1 < found.length ? found[index + 1].position : to) - position, chord}))
    }
}
