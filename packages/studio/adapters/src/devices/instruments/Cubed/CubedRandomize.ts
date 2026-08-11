import {Arrays, clamp, int, unitValue} from "@opendaw/lib-std"
import {MidiKeys} from "@opendaw/lib-dsp"
import {CubedStep} from "./CubedStep"

export type CubedContour = "free" | "walk" | "rise" | "fall"

export type CubedRandomizeOptions = {
    root: int
    scale: MidiKeys.PredefinedScale
    octave: int
    octaves: int
    density: unitValue
    accent: unitValue
    slide: unitValue
    motif: int
    contour: CubedContour
    rootFirst: boolean
}

export namespace CubedRandomize {
    export const Contours: ReadonlyArray<CubedContour> = ["free", "walk", "rise", "fall"]
    export const Motifs: ReadonlyArray<int> = [0, 2, 3, 4, 8]

    export const Default: CubedRandomizeOptions = {
        root: 0,
        scale: MidiKeys.StockScales[1],
        octave: 1,
        octaves: 3,
        density: 0.6,
        accent: 0.3,
        slide: 0.2,
        motif: 0,
        contour: "free",
        rootFirst: true
    }

    const keysOf = (scale: MidiKeys.Scale): ReadonlyArray<int> => {
        const keys = Arrays.create(index => index, 12).filter(key => scale.has(key))
        return keys.length === 0 ? [0] : keys
    }

    export const steps = (options: CubedRandomizeOptions, count: int): ReadonlyArray<int> => {
        const keys = keysOf(options.scale)
        const octaves = Math.max(1, options.octaves)
        const span = keys.length * octaves
        const base = (options.octave + 2) * 12 + options.root
        const noteOf = (degree: int): int => {
            const bounded = clamp(degree, 0, span - 1)
            return clamp(base + keys[bounded % keys.length] + Math.floor(bounded / keys.length) * 12, 0, 127)
        }
        const period = options.motif > 0 ? Math.min(options.motif, count) : count
        const jitter = (amount: int): int => Math.round((Math.random() * 2 - 1) * amount)
        const degrees = new Array<int>(period)
        for (let index = 0; index < period; index++) {
            const ramp = period < 2 ? 0 : (index / (period - 1)) * (span - 1)
            degrees[index] = options.rootFirst && index === 0 ? 0 : clamp(
                options.contour === "walk" ? (index === 0 ? span >> 1 : degrees[index - 1] + jitter(2))
                    : options.contour === "rise" ? Math.round(ramp) + jitter(1)
                        : options.contour === "fall" ? Math.round(span - 1 - ramp) + jitter(1)
                            : Math.floor(Math.random() * span), 0, span - 1)
        }
        const motif = Arrays.create(index => CubedStep.pack({
            note: noteOf(degrees[index]),
            active: (options.rootFirst && index === 0) || Math.random() < options.density,
            slide: Math.random() < options.slide,
            accent: Math.random() < options.accent
        }), period)
        return Arrays.create(index => motif[index % period], count)
    }
}
