import {clamp, int, isDefined, Option} from "@opendaw/lib-std"
import {MidiKeys} from "@opendaw/lib-dsp"
import {CubedStep} from "./CubedStep"

export type CubedPatternData = {
    length: int
    steps: ReadonlyArray<CubedStep>
}

export namespace CubedPatternData {
    export const MaxSteps: int = 64
    export const Type = "cubed-pattern"
    export const Version = 1

    /** Accepts `60`, `C3` or `C#3`. The octave offset matches MidiKeys.toFullString. */
    export const parseNote = (text: string): Option<int> => {
        const trimmed = text.trim()
        if (/^\d+$/.test(trimmed)) {
            const value = parseInt(trimmed, 10)
            return value >= 0 && value <= 127 ? Option.wrap(value) : Option.None
        }
        const match = trimmed.match(/^([A-Ga-g])([#b]?)(-?\d+)$/)
        if (match === null) {return Option.None}
        const bases: Record<string, int> = {C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11}
        const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0
        const note = bases[match[1].toUpperCase()] + accidental + (parseInt(match[3], 10) + 2) * 12
        return note >= 0 && note <= 127 ? Option.wrap(note) : Option.None
    }

    export const toJSON = ({length, steps}: CubedPatternData): string => JSON.stringify({
        type: Type,
        version: Version,
        length,
        steps: steps.map(({note, active, slide, accent}) => ({
            note: MidiKeys.toFullString(note), gate: active, slide, accent
        }))
    }, null, 2)

    export const fromJSON = (text: string): Option<CubedPatternData> =>
        Option.tryCatch(() => JSON.parse(text)).flatMap(readObject)

    const readNote = (value: unknown): Option<int> => {
        if (typeof value === "number" && Number.isFinite(value)) {
            return Option.wrap(clamp(Math.round(value), 0, 127))
        }
        return typeof value === "string" ? parseNote(value) : Option.None
    }

    const readFlag = (value: unknown): boolean => value === true

    const readStep = (value: unknown): Option<CubedStep> => {
        if (typeof value !== "object" || value === null) {return Option.None}
        const source = value as Record<string, unknown>
        return readNote(source.note).map(note => ({
            note,
            active: readFlag(isDefined(source.gate) ? source.gate : source.active),
            slide: readFlag(source.slide),
            accent: readFlag(source.accent)
        }))
    }

    const readObject = (value: unknown): Option<CubedPatternData> => {
        if (typeof value !== "object" || value === null) {return Option.None}
        const source = value as Record<string, unknown>
        if (isDefined(source.type) && source.type !== Type) {return Option.None}
        if (!Array.isArray(source.steps)) {return Option.None}
        const steps = source.steps.slice(0, MaxSteps).map(readStep)
        if (steps.some(step => step.isEmpty())) {return Option.None}
        if (steps.length === 0) {return Option.None}
        const length = typeof source.length === "number" && Number.isFinite(source.length)
            ? clamp(Math.round(source.length), 1, steps.length)
            : steps.length
        return Option.wrap({length, steps: steps.map(step => step.unwrap())})
    }
}
