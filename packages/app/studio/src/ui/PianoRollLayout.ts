import {MidiKeys} from "@moises-ai/lib-dsp"
import {Arrays, asDefined, int, Lazy, Size} from "@moises-ai/lib-std"

export type KeyProperties = { key: int, x: number }

export type KeySizes = {
    whiteKeys: Size
    blackKeys: Size
}

export class PianoRollLayout {
    @Lazy
    static Defaults() {
        return [
            new PianoRollLayout(21, 108), // 88
            new PianoRollLayout(28, 103), // 76
            new PianoRollLayout(36, 96), // 61
            new PianoRollLayout(36, 84) // 49
        ]
    }

    static getByIndex(index: int): PianoRollLayout {
        const layouts = this.Defaults()
        return layouts[index] ?? layouts[0]
    }

    static DefaultKeySizes: KeySizes = {
        whiteKeys: {width: 20, height: 90},
        blackKeys: {width: 13, height: 50}
    }

    static readonly BlackKeyOffsets: Record<int, number> = {1: 0.55, 3: 0.45, 6: 0.55, 8: 0.50, 10: 0.45} as const

    static #moveToNextWhiteKey(key: int, direction: -1 | 1): int {
        while (MidiKeys.isBlackKey(key)) key += direction
        return key
    }

    readonly #min: int
    readonly #max: int
    readonly #sizes: KeySizes

    readonly #whiteKeysX: Array<KeyProperties>
    readonly #blackKeysX: Array<KeyProperties>
    readonly #octaveSplits: Array<number>
    readonly #centered: Array<number>

    constructor(min: int, max: int, sizes: KeySizes = PianoRollLayout.DefaultKeySizes) {
        this.#min = PianoRollLayout.#moveToNextWhiteKey(min, -1)
        this.#max = PianoRollLayout.#moveToNextWhiteKey(max, 1)
        this.#sizes = sizes
        this.#whiteKeysX = []
        this.#blackKeysX = []
        this.#octaveSplits = []
        this.#centered = Arrays.create(() => 0, 128)
        this.#initialize()
    }

    get min(): int {return this.#min}
    get max(): int {return this.#max}
    get sizes(): KeySizes {return this.#sizes}
    get count(): int {return this.#max - this.#min + 1}
    get whiteKeys(): ReadonlyArray<KeyProperties> {return this.#whiteKeysX}
    get blackKeys(): ReadonlyArray<KeyProperties> {return this.#blackKeysX}
    get octaveSplits(): ReadonlyArray<number> {return this.#octaveSplits}

    getCenteredX(index: int): number {return this.#centered[index]}
    getFillStyle(hue: number, isPlaying: boolean): string {
        const saturation = isPlaying ? 100 : 45
        const lightness = isPlaying ? 80 : 60
        return `hsl(${hue}, ${saturation}%, ${lightness}%)`
    }

    #initialize(): void {
        const {BlackKeyOffsets} = PianoRollLayout
        const {sizes: {whiteKeys, blackKeys}} = this
        let whiteIndex = 0
        for (let key = this.#min | 0; key <= this.#max; key++) {
            const localNote = key % 12
            if (MidiKeys.isBlackKey(key)) {
                const offset = asDefined(BlackKeyOffsets[localNote], "black index not found")
                const x = (whiteIndex - offset) * whiteKeys.width + (whiteKeys.width - blackKeys.width) / 2.0
                this.#blackKeysX.push({key, x})
                this.#centered[key] = whiteIndex - offset + 0.5
            } else {
                const x = whiteIndex * whiteKeys.width
                this.#whiteKeysX.push({key, x})
                this.#centered[key] = whiteIndex + 0.5
                if (localNote === 0 || localNote === 5) {this.#octaveSplits.push(whiteIndex)}
                whiteIndex++
            }
        }
        this.#octaveSplits.forEach((x, index, array) => array[index] = x / whiteIndex)
        this.#centered.forEach((x, index, array) => array[index] = x / whiteIndex)
    }
}