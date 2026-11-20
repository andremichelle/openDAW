import {Nullable, unitValue} from "@opendaw/lib-std"
import {Interpolation, ppqn} from "@opendaw/lib-dsp"

export namespace ValuePaintCleanup {
    export type Stroke = { position: ppqn, value: unitValue }
    export type Neighbour = { value: unitValue, interpolation: Interpolation }

    export const reduce = (strokes: ReadonlyArray<Stroke>, interpolation: Interpolation,
                           before: Nullable<Neighbour>, after: Nullable<Neighbour>): Array<Stroke> => {
        const result: Array<Stroke> = []
        let previous: Nullable<Neighbour> = before
        strokes.forEach((stroke, index) => {
            const next: Nullable<Neighbour> = index + 1 < strokes.length
                ? {value: strokes[index + 1].value, interpolation} : after
            const redundant = previous !== null && previous.value === stroke.value && (next === null
                || next.value === stroke.value
                || (previous.interpolation.type === "none" && interpolation.type === "none"))
            if (redundant) {return}
            result.push(stroke)
            previous = {value: stroke.value, interpolation}
        })
        return result
    }
}
