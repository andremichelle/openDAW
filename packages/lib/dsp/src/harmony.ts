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
    export type ChordShape = { readonly name: string, readonly suffix: string, readonly bits: int }

    export const DefaultKey: Key = {root: 0, bits: MajorBits}

    const shape = (name: string, suffix: string, ...intervals: ReadonlyArray<int>): ChordShape =>
        ({name, suffix, bits: intervals.reduce((bits, interval) => bits | (1 << interval), 0)})

    export const ChordShapes: ReadonlyArray<ChordShape> = [
        shape("Major", "", 0, 4, 7),
        shape("Minor", "m", 0, 3, 7),
        shape("Diminished", "dim", 0, 3, 6),
        shape("Augmented", "aug", 0, 4, 8),
        shape("Sus2", "sus2", 0, 2, 7),
        shape("Sus4", "sus4", 0, 5, 7),
        shape("Dominant 7th", "7", 0, 4, 7, 10),
        shape("Major 7th", "maj7", 0, 4, 7, 11),
        shape("Minor 7th", "m7", 0, 3, 7, 10),
        shape("Half Diminished", "m7♭5", 0, 3, 6, 10),
        shape("Diminished 7th", "dim7", 0, 3, 6, 9)
    ]

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

    export const chord = ({root, bits}: Key, degree: int, shift: int, shapeBits: int,
                          notes: int = 3, inversion: int = 0): Option<Chord> => {
        if (!isHeptatonic(bits) || degree < 1 || degree > 7) {return Option.None}
        const steps: Array<int> = []
        for (let index = 0; index < 12; index++) {if ((bits & (1 << index)) !== 0) {steps.push(index)}}
        const index = degree - 1
        const base = steps[index]
        const stack: Array<int> = []
        if (shapeBits !== 0) {
            for (let interval = 0; interval < 12; interval++) {if ((shapeBits & (1 << interval)) !== 0) {stack.push(interval)}}
        } else {
            for (let note = 0; note < Math.min(Math.max(notes, 3), 5); note++) {
                const step = index + note * 2
                stack.push(steps[step % 7] + Math.floor(step / 7) * 12 - base)
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

    export const keyName = ({root, bits}: Key): string => `${MidiKeys.Names.English[root]} ${scaleName(bits)}`

    const stackSuffix = (stack: ReadonlyArray<int>): string => {
        const [, third, fifth, seventh, ninth] = stack
        const triad = third === 4 && fifth === 7 ? "" : third === 3 && fifth === 7 ? "m"
            : third === 3 && fifth === 6 ? "dim" : third === 4 && fifth === 8 ? "aug" : "*"
        if (!isDefined(seventh)) {return triad}
        const suffix = triad === "" ? (seventh === 11 ? "maj7" : seventh === 10 ? "7" : "*")
            : triad === "m" ? (seventh === 10 ? "m7" : seventh === 11 ? "m(maj7)" : "*")
                : triad === "dim" ? (seventh === 10 ? "m7♭5" : seventh === 9 ? "dim7" : "*")
                    : triad === "aug" ? (seventh === 11 ? "maj7♯5" : seventh === 10 ? "7♯5" : "*") : "*"
        if (!isDefined(ninth)) {return suffix}
        return ninth === 14 ? suffix.replace("7", "9") : ninth === 13 ? `${suffix}♭9` : ninth === 15 ? `${suffix}♯9` : "*"
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
