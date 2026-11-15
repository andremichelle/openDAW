import {ParameterPointerRules, UnipolarConstraints} from "../../std/Defaults"

/** The automatable fields every openDrum device box is made of. */
export namespace OpenDrumFields {
    export const range = (name: string, value: number, min: number, max: number,
                          scaling: "linear" | "exponential", unit: string) => ({
        type: "float32", name, value, pointerRules: ParameterPointerRules, constraints: {min, max, scaling}, unit
    } as const)
    export const unipolar = (name: string, value: number) => ({
        type: "float32", name, value, pointerRules: ParameterPointerRules, ...UnipolarConstraints
    } as const)
    export const bipolar = (name: string, value: number) => ({
        type: "float32", name, value, pointerRules: ParameterPointerRules, constraints: "bipolar", unit: "%"
    } as const)
    export const choice = (name: string, value: number, length: number) => ({
        type: "int32", name, value, pointerRules: ParameterPointerRules, constraints: {length}, unit: ""
    } as const)
    export const integer = (name: string, value: number, min: number, max: number) => ({
        type: "int32", name, value, pointerRules: ParameterPointerRules, constraints: {min, max}, unit: ""
    } as const)
}
