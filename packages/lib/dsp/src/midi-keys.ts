import {byte, clampUnit, int} from "@moises-ai/lib-std"

export namespace MidiKeys {
    export const BlackKeyIndices = [1, 3, 6, 8, 10]
    export const BlackKeyBits = BlackKeyIndices.reduce((bits: int, keyIndex: int) => (bits |= 1 << keyIndex), 0)
    export const Names = {
        English: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"],
        German: ["C", "Cis", "D", "Dis", "E", "F", "Fis", "G", "Gis", "A", "Ais", "H"],
        Solfege: ["Do", "Do#", "Ré", "Ré#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"],
        French: ["Do", "Do#", "Ré", "Ré#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"],
        Spanish: ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"],
        Japanese: ["ド", "ド♯", "レ", "レ♯", "ミ", "ファ", "ファ♯", "ソ", "ソ♯", "ラ", "ラ♯", "シ"]
    }
    export const isBlackKey = (note: int) => (BlackKeyBits & (1 << (note % 12))) !== 0
    export const toFullString = (note: int): string => `${Names.English[note % 12]}${(Math.floor(note / 12) - 2)}`

    export const keyboardTracking = (note: byte, amount: number): number => clampUnit((note - 60) * amount)

    export interface Scale {
        get bits(): int
        has(key: int): boolean
        equals(other: Scale): boolean
    }

    export interface PredefinedScale extends Scale {readonly name: string}

    class PredefinedScaleImpl implements Scale {
        readonly #name: string
        readonly #bits: int

        constructor(name: string, ...keys: ReadonlyArray<byte>) {
            this.#name = name
            this.#bits = keys.reduce((bits: int, keyIndex: int) => (bits |= 1 << keyIndex), 0)
        }

        get name(): string {return this.#name}
        get bits(): int {return this.#bits}

        has(note: int): boolean {return (this.#bits & (1 << (note % 12))) !== 0}
        equals(other: Scale): boolean {return this.#bits === other.bits}
    }

    export const StockScales: ReadonlyArray<PredefinedScale> = [
        new PredefinedScaleImpl("Major", 0, 2, 4, 5, 7, 9, 11),
        new PredefinedScaleImpl("Natural Minor", 0, 2, 3, 5, 7, 8, 10),
        new PredefinedScaleImpl("Harmonic Minor", 0, 2, 3, 5, 7, 8, 11),
        new PredefinedScaleImpl("Melodic Minor", 0, 2, 3, 5, 7, 9, 11),
        new PredefinedScaleImpl("Dorian", 0, 2, 3, 5, 7, 9, 10),
        new PredefinedScaleImpl("Phrygian", 0, 1, 3, 5, 7, 8, 10),
        new PredefinedScaleImpl("Lydian", 0, 2, 4, 6, 7, 9, 11),
        new PredefinedScaleImpl("Mixolydian", 0, 2, 4, 5, 7, 9, 10),
        new PredefinedScaleImpl("Locrian", 0, 1, 3, 5, 6, 8, 10),
        new PredefinedScaleImpl("Pentatonic Major", 0, 2, 4, 7, 9),
        new PredefinedScaleImpl("Pentatonic Minor", 0, 3, 5, 7, 10),
        new PredefinedScaleImpl("Blues", 0, 3, 5, 6, 7, 10),
        new PredefinedScaleImpl("Whole Tone", 0, 2, 4, 6, 8, 10),
        new PredefinedScaleImpl("Diminished", 0, 2, 3, 5, 6, 8, 9, 11),
        new PredefinedScaleImpl("Augmented", 0, 3, 4, 7, 8, 11)
    ] as const
}