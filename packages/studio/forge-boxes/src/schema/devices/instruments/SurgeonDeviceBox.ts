import {BoxSchema, FieldRecord} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

type Value = {
    readonly name: string
    readonly type: "int32" | "float32"
    readonly value: number
    readonly constraints: "unipolar" | "bipolar" | { min: number, max: number, scaling?: "linear" | "exponential" }
    readonly unit: string
}

const int = (name: string, min: number, max: number, value: number): Value =>
    ({name, type: "int32", value, constraints: {min, max}, unit: ""})
const unipolar = (name: string, value: number): Value => ({name, type: "float32", value, constraints: "unipolar", unit: "%"})
const linear = (name: string, min: number, max: number, value: number, unit: string): Value =>
    ({name, type: "float32", value, constraints: {min, max, scaling: "linear"}, unit})
const exponential = (name: string, min: number, max: number, value: number, unit: string): Value =>
    ({name, type: "float32", value, constraints: {min, max, scaling: "exponential"}, unit})

const LaneNames = ["a", "b", "c", "d"]
const LaneSteps = [5, 9, 4, 11]
const LaneSeeds = [21, 22, 23, 24]

// the sound parameters a lane can move, keys 30 and up, their lane amounts from key 100 (parameter * 4 + lane)
const Sound: ReadonlyArray<Value> = [
    exponential("first-ratio", 0.25, 8.0, 2.41, ""),
    unipolar("feedback", 0.0),
    exponential("second-ratio", 0.25, 16.0, 5.19, ""),
    linear("second-depth", 0.0, 1.5, 0.6, ""),
    int("wave", 0, 3, 2),
    linear("depth", 0.0, 4.0, 0.6, ""),
    linear("strike", 0.0, 8.0, 1.0, ""),
    exponential("strike-decay", 0.02, 1.0, 0.14, "s"),
    unipolar("fold", 0.0),
    int("fold-place", 0, 1, 0),
    unipolar("length", 0.0),
    unipolar("held", 0.08),
    linear("sine-gain", 0.0, 1.5, 0.6, ""),
    int("sine-pitch", 0, 1, 0),
    linear("glide", 0.0, 0.3, 0.04, "s"),
    unipolar("velocity", 0.7)
]
const DefaultAmounts: Readonly<Record<string, number>> = {"feedback-a": 0.8, "strike-b": 0.75, "fold-c": 0.5, "length-d": 1.0}

// one pattern: rate, the pitch loop, the four lanes, the sound and its lane amounts. The defaults are a locked loop
const values = (): ReadonlyArray<readonly [number, Value]> => [
    [1, int("rate", 0, 2, 1)],
    [2, int("steps", 1, 32, 7)],
    [3, int("seed", 0, 99_999, 1)],
    [4, unipolar("mutate", 0.0)],
    [5, linear("range", 0.0, 36.0, 13.0, "st")],
    [6, unipolar("density", 0.8)],
    [7, unipolar("tie", 0.25)],
    [8, unipolar("slide", 0.0)],
    [9, unipolar("accent", 0.6)],
    ...LaneNames.flatMap((lane, index): Array<readonly [number, Value]> => [
        [10 + index * 3, int(`lane-${lane}-steps`, 1, 32, LaneSteps[index])],
        [11 + index * 3, int(`lane-${lane}-seed`, 0, 99_999, LaneSeeds[index])],
        [12 + index * 3, unipolar(`lane-${lane}-mutate`, 0.0)]
    ]),
    ...Sound.map((value, index): readonly [number, Value] => [30 + index, value]),
    ...Sound.flatMap(({name}, index) => LaneNames.map((lane, laneIndex): readonly [number, Value] => {
        const amount = `${name}-${lane}`
        return [100 + index * 4 + laneIndex, {
            name: amount, type: "float32", value: DefaultAmounts[amount] ?? 0.0, constraints: "bipolar", unit: "%"
        }]
    }))
]

const fields = (automatable: boolean): FieldRecord<Pointers> => Object.fromEntries(values().map(([key, value]) =>
    [key, automatable ? {...value, pointerRules: ParameterPointerRules} : value])) as FieldRecord<Pointers>

export const SurgeonDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("SurgeonDeviceBox", "notes", {
    10: {
        type: "float32", name: "tune", pointerRules: ParameterPointerRules,
        value: 146.83, constraints: {min: 20.0, max: 2000.0, scaling: "exponential"}, unit: "Hz"
    },
    11: {
        type: "float32", name: "volume", pointerRules: ParameterPointerRules,
        value: -3.0, constraints: {min: -72.0, mid: -12.0, max: 0.0, scaling: "decibel"}, unit: "dB"
    },
    // which pattern plays, -1 is off. A change takes over at the next bar
    12: {type: "int32", name: "slot", pointerRules: ParameterPointerRules, value: 0, constraints: {min: -1, max: 7}, unit: ""},
    // the pattern the live controls belong to, it stays when the slot goes off
    13: {type: "int32", name: "pattern", value: 0, constraints: {min: 0, max: 7}, unit: ""},
    // the controls of the editor, every one automatable. An automated one keeps its automation in every pattern
    20: {type: "object", name: "live", class: {name: "SurgeonSound", fields: fields(true)}},
    // the stored patterns, plain values. The device plays these, an edit of a live control is kept here as well
    30: {
        type: "array", name: "patterns", length: 8, element: {
            type: "object", class: {name: "SurgeonPattern", fields: fields(false)}
        }
    }
})
