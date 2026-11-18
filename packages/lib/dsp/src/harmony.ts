import {int, isDefined, Option} from "@opendaw/lib-std"
import {MidiKeys} from "./midi-keys"

export namespace Harmony {
    export const MajorBits: int = 0b101010110101

    export type Key = { readonly root: int, readonly bits: int }
    // stack: intervals above the root in root position, voicing: after the inversion, bits: the voicing as a mask
    export type Chord = {
        readonly root: int, readonly stack: ReadonlyArray<int>, readonly voicing: ReadonlyArray<int>,
        readonly bits: int, readonly shaped: boolean
    }
    export type ChordShape = { readonly name: string, readonly suffix: string, readonly group: string, readonly bits: int }

    export const DefaultKey: Key = {root: 0, bits: MajorBits}

    // bits fold the intervals into one octave, shapeStack lifts the extensions back above it
    const shape = (group: string, name: string, suffix: string, ...intervals: ReadonlyArray<int>): ChordShape =>
        ({name, suffix, group, bits: intervals.reduce((bits, interval) => bits | (1 << (interval % 12)), 0)})

    export const ChordShapes: ReadonlyArray<ChordShape> = [
        shape("Triads", "Major", "", 0, 4, 7),
        shape("Triads", "Minor", "m", 0, 3, 7),
        shape("Triads", "Diminished", "dim", 0, 3, 6),
        shape("Triads", "Augmented", "aug", 0, 4, 8),
        shape("Suspended", "Sus2", "sus2", 0, 2, 7),
        shape("Suspended", "Sus4", "sus4", 0, 5, 7),
        shape("7th", "Dominant 7th", "7", 0, 4, 7, 10),
        shape("7th", "Major 7th", "maj7", 0, 4, 7, 11),
        shape("7th", "Minor 7th", "m7", 0, 3, 7, 10),
        shape("7th", "Half Diminished", "m7♭5", 0, 3, 6, 10),
        shape("7th", "Diminished 7th", "dim7", 0, 3, 6, 9),
        shape("6th", "Major 6th", "6", 0, 4, 7, 9),
        shape("6th", "Minor 6th", "m6", 0, 3, 7, 9),
        shape("6th", "6/9", "6/9", 0, 4, 7, 9, 14),
        shape("9th", "Add 9", "add9", 0, 4, 7, 14),
        shape("9th", "Minor Add 9", "m(add9)", 0, 3, 7, 14),
        shape("9th", "Dominant 9th", "9", 0, 4, 7, 10, 14),
        shape("9th", "Major 9th", "maj9", 0, 4, 7, 11, 14),
        shape("9th", "Minor 9th", "m9", 0, 3, 7, 10, 14),
        shape("11th", "Minor 11th", "m11", 0, 3, 7, 10, 14, 17),
        shape("13th", "Dominant 13th", "13", 0, 4, 7, 10, 14, 21),
        shape("13th", "Major 13th", "maj13", 0, 4, 7, 11, 14, 21),
        shape("13th", "Minor 13th", "m13", 0, 3, 7, 10, 14, 21),
        shape("Suspended", "7sus4", "7sus4", 0, 5, 7, 10),
        shape("Suspended", "9sus4", "9sus4", 0, 5, 7, 10, 14)
    ]

    export const ChordShapeGroups: ReadonlyArray<string> = ["Triads", "Suspended", "6th", "7th", "9th", "11th", "13th"]

    // WASM CONTRACT: math::harmony::shape_stack lifts the extensions (9th, 11th, 13th) above the octave
    export const shapeStack = (bits: int): ReadonlyArray<int> => {
        const has = (interval: int) => (bits & (1 << interval)) !== 0
        const third = has(3) || has(4), seventh = has(10) || has(11)
        const stack: Array<int> = []
        for (let interval = 0; interval < 12; interval++) {
            if (!has(interval)) {continue}
            const lifted = third && (interval === 2 || interval === 5) || seventh && has(5) && interval === 2
                || seventh && third && interval === 9
            stack.push(lifted ? interval + 12 : interval)
        }
        return stack.sort((left, right) => left - right)
    }

    export const countNotes = (bits: int): int => {
        let count = 0
        for (let index = 0; index < 12; index++) {if ((bits & (1 << index)) !== 0) {count++}}
        return count
    }

    export const isHeptatonic = (bits: int): boolean => countNotes(bits) === 7

    export const has = (pitch: int, {root, bits}: Key): boolean => (bits & (1 << (((pitch - root) % 12 + 12) % 12))) !== 0

    export const quantise = (pitch: int, key: Key): int => {
        if ((key.bits & 0xFFF) === 0) {return pitch}
        for (let distance = 0; distance < 12; distance++) {
            const down = pitch - distance
            if (down >= 0 && has(down, key)) {return down}
            const up = pitch + distance
            if (up <= 127 && has(up, key)) {return up}
        }
        return pitch
    }

    export const NaturalMinorBits: int = 0b010110101101
    const PentatonicMajorBits: int = 0b001010010101
    const PentatonicMinorBits: int = 0b010010101001
    const BluesBits: int = 0b010011101001
    const BluesDominant: ReadonlyArray<int> = [0, 4, 7, 10, 14]

    // pentatonic and blues melodies sit over the chords of their parent scale, other scales stack their own notes
    export const chordScale = (bits: int): int => bits === PentatonicMajorBits ? MajorBits
        : bits === PentatonicMinorBits || bits === BluesBits ? NaturalMinorBits : bits

    export const chordSource = ({root, bits}: Key): Option<string> => {
        const parent = chordScale(bits)
        if (parent === bits) {return Option.None}
        const name = `${MidiKeys.Names.English[root]} ${scaleName(parent)}`
        return Option.wrap(bits === BluesBits ? `${name}, steps 1, 4 and 5 as dominant 7ths` : name)
    }

    export const chord = ({root, bits}: Key, degree: int, shift: int, shapeBits: int,
                          notes: int = 3, inversion: int = 0): Option<Chord> => {
        if (degree < 1 || degree > 7) {return Option.None}
        const scale = chordScale(bits)
        const steps: Array<int> = []
        for (let index = 0; index < 12; index++) {if ((scale & (1 << index)) !== 0) {steps.push(index)}}
        if (steps.length < 3) {return Option.None}
        const at = (step: int): int => steps[step % steps.length] + Math.floor(step / steps.length) * 12
        const index = degree - 1
        const base = at(index)
        const count = Math.min(Math.max(notes, 3), 7)
        const stack: Array<int> = []
        if (shapeBits !== 0) {
            stack.push(...shapeStack(shapeBits))
        } else if (bits === BluesBits && shift === 0 && (degree === 1 || degree === 4 || degree === 5)) {
            stack.push(...BluesDominant.slice(0, Math.max(count, 4)))
        } else {
            for (let note = 0; note < count; note++) {
                const interval = at(index + note * 2) - base
                if (!stack.some(other => other % 12 === interval % 12)) {stack.push(interval)}
            }
            // 11ths and 13ths drop the perfect fifth, and the natural 11 above a major third
            if (count >= 6) {
                const major = stack.includes(4)
                stack.splice(0, stack.length, ...stack.filter(interval => interval !== 7 && !(major && interval === 17)))
            }
        }
        const rotate = Math.min(Math.max(inversion, 0), stack.length - 1)
        const voicing = [...stack.slice(rotate), ...stack.slice(0, rotate).map(interval => interval + 12)]
        return Option.wrap({
            root: ((root + base + shift) % 12 + 12) % 12, stack, voicing,
            bits: voicing.reduce((mask, interval) => mask | (1 << interval), 0), shaped: shapeBits !== 0
        })
    }

    export const scaleName = (bits: int): string =>
        MidiKeys.StockScales.find(scale => scale.bits === bits)?.name ?? "Custom"

    const ScaleAbbreviations: ReadonlyArray<string> =
        ["maj", "min", "hmin", "mmin", "dor", "phr", "lyd", "mix", "loc", "pmaj", "pmin", "blu", "whl", "dim", "aug"]

    export const scaleAbbreviation = (bits: int): string => {
        const index = MidiKeys.StockScales.findIndex(scale => scale.bits === bits)
        return index === -1 ? "*" : ScaleAbbreviations[index]
    }

    export const keyName = ({root, bits}: Key): string => `${MidiKeys.Names.English[root]} ${scaleName(bits)}`

    const stackSuffix = (stack: ReadonlyArray<int>): string => {
        const lows = stack.filter(interval => interval < 12), extensions = stack.filter(interval => interval >= 12)
        const third = lows.find(interval => interval === 3 || interval === 4)
        const fifth = lows.find(interval => interval >= 6 && interval <= 8) ?? (extensions.length > 0 ? 7 : undefined)
        const seventh = lows.find(interval => interval >= 9 && interval <= 11)
        const triad = third === 4 && fifth === 7 ? "" : third === 3 && fifth === 7 ? "m"
            : third === 3 && fifth === 6 ? "dim" : third === 4 && fifth === 8 ? "aug" : "*"
        if (!isDefined(seventh)) {return triad}
        const suffix = triad === "" ? (seventh === 11 ? "maj7" : seventh === 10 ? "7" : "*")
            : triad === "m" ? (seventh === 10 ? "m7" : seventh === 11 ? "m(maj7)" : "*")
                : triad === "dim" ? (seventh === 10 ? "m7♭5" : seventh === 9 ? "dim7" : "*")
                    : triad === "aug" ? (seventh === 11 ? "maj7♯5" : seventh === 10 ? "7♯5" : "*") : "*"
        const naturals: Record<int, int> = {14: 9, 17: 11, 21: 13}
        const altered: Record<int, string> = {13: "♭9", 15: "♯9", 18: "♯11", 20: "♭13"}
        let highest = 0, alterations = ""
        for (const interval of extensions) {
            if (isDefined(naturals[interval])) {highest = naturals[interval]} else if (isDefined(altered[interval])) {
                alterations += altered[interval]
            } else {return "*"}
        }
        return (highest === 0 ? suffix : suffix.replace("7", String(highest))) + alterations
    }

    export const chordName = ({root, stack, voicing, shaped}: Chord): string => {
        const shapeBits = stack.reduce((mask, interval) => mask | (1 << (interval % 12)), 0)
        const suffix = shaped ? ChordShapes.find(chordShape => chordShape.bits === shapeBits)?.suffix ?? "*" : stackSuffix(stack)
        const bass = voicing[0] === stack[0] ? "" : `/${MidiKeys.Names.English[(root + voicing[0]) % 12]}`
        return `${MidiKeys.Names.English[root]}${suffix}${bass}`
    }

    export const pitchClasses = ({root, voicing}: Chord): ReadonlyArray<int> =>
        voicing.map(interval => (root + interval) % 12)

    export const degreeName = (degree: int, shift: int): string =>
        `${shift < 0 ? "♭" : shift > 0 ? "♯" : ""}${degree}`
}
