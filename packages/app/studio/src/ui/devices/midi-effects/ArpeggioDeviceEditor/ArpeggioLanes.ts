import {clamp, int} from "@opendaw/lib-std"
import {ArpeggioDeviceBox} from "@opendaw/studio-boxes"

type StepArray = ArpeggioDeviceBox["stepKinds"]

export namespace ArpeggioLanes {
    export const Note = 0
    export const Rest = 1
    export const Tie = 2
    export const Chord = 3
    export const Kinds: ReadonlyArray<string> = ["note", "rest", "tie", "chord"]
    export const KindLabels: ReadonlyArray<string> = ["Note", "Rest", "Tie", "Chord"]

    export type Spec = {
        readonly label: string
        readonly min: int
        readonly max: int
        readonly bipolar: boolean
        readonly discrete: boolean
        readonly mark?: int
        readonly fields: (box: ArpeggioDeviceBox) => StepArray
        readonly ratio: (value: int) => number
        readonly fromRatio: (ratio: number) => int
        readonly format: (value: int) => string
    }

    const spec = (label: string, min: int, max: int, fields: (box: ArpeggioDeviceBox) => StepArray,
                  format: (value: int) => string, options: { bipolar?: boolean, discrete?: boolean, mark?: int } = {}): Spec => ({
        label, min, max, fields, format,
        bipolar: options.bipolar ?? false,
        discrete: options.discrete ?? false,
        mark: options.mark,
        ratio: (value: int) => (clamp(value, min, max) - min) / (max - min),
        fromRatio: (ratio: number) => Math.round(min + clamp(ratio, 0.0, 1.0) * (max - min))
    })

    const percent = (value: int) => `${value}%`
    const signed = (value: int) => value > 0 ? `+${value}` : `${value}`

    export const Values: ReadonlyArray<Spec> = [
        spec("Velocity", 0, 100, box => box.stepVelocities, percent),
        spec("Gate", 0, 200, box => box.stepGates, percent, {mark: 100}),
        spec("Pitch", -12, 12, box => box.stepTransposes, signed, {bipolar: true, discrete: true}),
        spec("Octave", -2, 2, box => box.stepOctaves, signed, {bipolar: true, discrete: true}),
        spec("Chance", 0, 100, box => box.stepChances, percent),
        spec("Ratchet", 1, 7, box => box.stepRatchets, value => String(value), {discrete: true})
    ]

    const Defaults: ReadonlyArray<int> = [Note, 100, 100, 0, 0, 100, 1]

    const arrays = (box: ArpeggioDeviceBox): ReadonlyArray<StepArray> => [
        box.stepKinds, box.stepVelocities, box.stepGates, box.stepTransposes, box.stepOctaves, box.stepChances, box.stepRatchets]

    // Rotates every lane within the pattern length, positive moves the steps to the left.
    export const rotate = (box: ArpeggioDeviceBox, offset: int): void => {
        const length = box.patternLength.getValue()
        arrays(box).forEach(array => {
            const fields = array.fields().slice(0, length)
            const values = fields.map(field => field.getValue())
            fields.forEach((field, index) => field.setValue(values[(index + offset + length) % length]))
        })
    }

    export const clear = (box: ArpeggioDeviceBox): void =>
        arrays(box).forEach((array, lane) => array.fields().forEach(field => field.setValue(Defaults[lane])))
}
