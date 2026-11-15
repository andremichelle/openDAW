import {clamp, int, Option} from "@opendaw/lib-std"
import {CubedPatternData} from "./CubedPatternData"
import {CubedStep} from "./CubedStep"

export namespace CubedPatternTransform {
    const inRange = (note: int): boolean => note >= 0 && note <= 127

    // refused when a playing step would leave the MIDI range, silent steps are clamped
    const mapNotes = ({length, steps}: CubedPatternData, map: (note: int) => int): Option<CubedPatternData> => {
        if (steps.some(step => step.active && !inRange(map(step.note)))) {return Option.None}
        return Option.wrap({length, steps: steps.map(step => ({...step, note: clamp(map(step.note), 0, 127)}))})
    }

    export const transpose = (data: CubedPatternData, semitones: int): Option<CubedPatternData> =>
        mapNotes(data, note => note + semitones)

    export const invert = (data: CubedPatternData, pivot: int): Option<CubedPatternData> =>
        mapNotes(data, note => 2 * pivot - note)

    export const double = ({length, steps}: CubedPatternData): CubedPatternData => {
        const doubled = Math.min(length * 2, CubedPatternData.MaxSteps)
        return {length: doubled, steps: Array.from({length: doubled}, (_, index) => steps[index % length])}
    }

    // a slide belongs to the transition into the next step, so it moves with that transition
    export const reverse = ({length, steps}: CubedPatternData): CubedPatternData => ({
        length,
        steps: Array.from({length}, (_, index): CubedStep => ({
            ...steps[length - 1 - index],
            slide: steps[(2 * length - 2 - index) % length].slide
        }))
    })
}
