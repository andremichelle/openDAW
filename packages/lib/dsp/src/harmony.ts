import {int, Option} from "@opendaw/lib-std"
import {MidiKeys} from "./midi-keys"

export namespace Harmony {
    export const MajorBits: int = 0b101010110101

    export type Key = { readonly root: int, readonly bits: int }
    export type Chord = { readonly root: int, readonly bits: int }
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

    export const chord = ({root, bits}: Key, degree: int, shift: int, shapeBits: int): Option<Chord> => {
        if (!isHeptatonic(bits) || degree < 1 || degree > 7) {return Option.None}
        const steps: Array<int> = []
        for (let index = 0; index < 12; index++) {if ((bits & (1 << index)) !== 0) {steps.push(index)}}
        const index = degree - 1
        const base = steps[index]
        const chordBits = shapeBits !== 0 ? shapeBits : 1
            | (1 << ((steps[(index + 2) % 7] - base + 12) % 12))
            | (1 << ((steps[(index + 4) % 7] - base + 12) % 12))
        return Option.wrap({root: ((root + base + shift) % 12 + 12) % 12, bits: chordBits})
    }

    export const scaleName = (bits: int): string =>
        MidiKeys.StockScales.find(scale => scale.bits === bits)?.name ?? "Custom"

    export const keyName = ({root, bits}: Key): string => `${MidiKeys.Names.English[root]} ${scaleName(bits)}`

    export const chordName = ({root, bits}: Chord): string => {
        const known = ChordShapes.find(chordShape => chordShape.bits === bits)
        return `${MidiKeys.Names.English[root]}${known?.suffix ?? "*"}`
    }

    export const degreeName = (degree: int, shift: int): string =>
        `${shift < 0 ? "♭" : shift > 0 ? "♯" : ""}${degree}`
}
