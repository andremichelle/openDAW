import {
    BooleanField,
    Constraints,
    Float32Field,
    Int32Field,
    PointerTypes,
    PrimitiveField,
    PrimitiveValues,
    StringField
} from "@opendaw/lib-box"
import {clamp, float, int, isNull, isUndefined, panic} from "@opendaw/lib-std"

const hasValues = (constraints: Constraints.Int32): constraints is { values: Array<int> } =>
    typeof constraints === "object" && Object.hasOwn(constraints, "values")
const hasLength = (constraints: Constraints.Int32): constraints is { length: int } =>
    typeof constraints === "object" && Object.hasOwn(constraints, "length")

export namespace Guard {
    export const number = (value: unknown, name: string): number => {
        if (typeof value !== "number") {
            return panic(new TypeError(`${name}: expected a number, got ${describe(value)}`))
        }
        if (Number.isNaN(value)) {return panic(new TypeError(`${name}: NaN is not a valid value`))}
        return value
    }

    export const finite = (value: unknown, name: string): number => {
        const result = number(value, name)
        if (!Number.isFinite(result)) {return panic(new RangeError(`${name}: ${result} is not finite`))}
        return result
    }

    export const integer = (value: unknown, name: string): int => Math.round(finite(value, name))

    export const boolean = (value: unknown, name: string): boolean => {
        if (typeof value !== "boolean") {
            return panic(new TypeError(`${name}: expected a boolean, got ${describe(value)}`))
        }
        return value
    }

    export const string = (value: unknown, name: string): string => {
        if (typeof value !== "string") {
            return panic(new TypeError(`${name}: expected a string, got ${describe(value)}`))
        }
        return value
    }

    export const oneOf = <T extends string | number>(value: unknown, values: ReadonlyArray<T>, name: string): T => {
        if (!values.includes(value as T)) {
            return panic(new RangeError(`${name}: ${describe(value)} is not one of ${values.map(String).join(", ")}`))
        }
        return value as T
    }

    export const float32 = (constraints: Constraints.Float32, value: unknown, name: string): float => {
        if (constraints === "any") {return finite(value, name)}
        if (constraints === "unipolar") {return clamp(finite(value, name), 0.0, 1.0)}
        if (constraints === "bipolar") {return clamp(finite(value, name), -1.0, 1.0)}
        if (constraints === "decibel") {
            const result = number(value, name)
            if (result === Number.POSITIVE_INFINITY) {return panic(new RangeError(`${name}: +Infinity is not a valid gain`))}
            return Math.min(result, 0.0)
        }
        if (constraints === "non-negative") {return Math.max(finite(value, name), 0.0)}
        if (constraints === "positive") {
            const result = finite(value, name)
            if (result <= 0.0) {return panic(new RangeError(`${name}: ${result} must be positive`))}
            return result
        }
        return clamp(finite(value, name), constraints.min, constraints.max)
    }

    export const int32 = (constraints: Constraints.Int32, value: unknown, name: string): int => {
        const result = integer(value, name)
        if (constraints === "any") {return result}
        if (constraints === "index" || constraints === "non-negative") {return Math.max(result, 0)}
        if (constraints === "positive") {
            if (result <= 0) {return panic(new RangeError(`${name}: ${result} must be positive`))}
            return result
        }
        if (hasValues(constraints)) {return oneOf(result, constraints.values, name)}
        if (hasLength(constraints)) {
            if (result < 0 || result >= constraints.length) {
                return panic(new RangeError(`${name}: ${result} must be in [0, ${constraints.length - 1}]`))
            }
            return result
        }
        return clamp(result, constraints.min, constraints.max)
    }

    export const field = (field: PrimitiveField<PrimitiveValues, PointerTypes>, value: unknown, name: string): PrimitiveValues => {
        if (field instanceof Float32Field) {return float32(field.constraints, value, name)}
        if (field instanceof Int32Field) {return int32(field.constraints, value, name)}
        if (field instanceof BooleanField) {return boolean(value, name)}
        if (field instanceof StringField) {return string(value, name)}
        return panic(`${name}: unsupported field type`)
    }

    export const describe = (value: unknown): string => {
        if (isNull(value)) {return "null"}
        if (isUndefined(value)) {return "undefined"}
        if (typeof value === "string") {return `"${value}"`}
        if (typeof value === "object") {return value.constructor?.name ?? "object"}
        return String(value)
    }
}
