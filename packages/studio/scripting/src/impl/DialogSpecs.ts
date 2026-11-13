import {isDefined, isNull, Optional, panic} from "@opendaw/lib-std"
import {DialogField, DialogOption} from "../Api"
import {DialogRequest, DialogValue} from "../ScriptHostProtocol"
import {Guard} from "./Guard"

export namespace DialogSpecs {
    const Types = ["section", "text", "number", "slider", "checkbox", "dropdown"] as const
    const Mappings = ["linear", "exp", "int"] as const

    type Raw = Record<string, unknown>

    export type Normalized = {
        request: DialogRequest
        // names of the fields that return a value, in the order of the values
        names: ReadonlyArray<string>
    }

    export const normalize = (spec: unknown): Normalized => {
        const raw = record(spec, "showDialog")
        const fields = record(raw.fields, "showDialog.fields")
        const names: Array<string> = []
        const normalized: Array<DialogField> = []
        for (const name of Object.keys(fields)) {
            if (name === "__proto__") {return panic(new RangeError(`showDialog: "__proto__" is not a valid field name`))}
            const field = normalizeField(fields[name], `showDialog.fields.${name}`)
            normalized.push(field)
            if (field.type !== "section") {names.push(name)}
        }
        return {
            request: {
                headline: Guard.string(raw.headline, "showDialog.headline"),
                okText: isDefined(raw.okText) ? Guard.string(raw.okText, "showDialog.okText") : "Ok",
                fields: normalized
            },
            names
        }
    }

    export const collect = (names: ReadonlyArray<string>, values: ReadonlyArray<DialogValue>): Record<string, DialogValue> => {
        if (!Array.isArray(values) || values.length !== names.length) {
            return panic(new Error("showDialog: the studio returned an unexpected result"))
        }
        return Object.fromEntries(names.map((name, index) => [name, values[index]]))
    }

    const normalizeField = (value: unknown, path: string): DialogField => {
        const raw = record(value, path)
        const type = Guard.oneOf(raw.type, Types, `${path}.type`)
        const label = Guard.string(raw.label, `${path}.label`)
        switch (type) {
            case "section":
                return {type, label}
            case "text":
                return {type, label, value: Guard.string(raw.value, `${path}.value`)}
            case "checkbox":
                return {type, label, value: Guard.boolean(raw.value, `${path}.value`)}
            case "number": {
                const min = optional(raw.min, `${path}.min`)
                const max = optional(raw.max, `${path}.max`)
                if (isDefined(min) && isDefined(max) && min >= max) {
                    return panic(new RangeError(`${path}: min ${min} must be below max ${max}`))
                }
                return {
                    type, label, min, max,
                    value: within(raw.value, min ?? Number.NEGATIVE_INFINITY, max ?? Number.POSITIVE_INFINITY, path),
                    step: step(raw.step, path),
                    unit: unit(raw.unit, path)
                }
            }
            case "slider": {
                const min = Guard.finite(raw.min, `${path}.min`)
                const max = Guard.finite(raw.max, `${path}.max`)
                if (min >= max) {return panic(new RangeError(`${path}: min ${min} must be below max ${max}`))}
                const mapping = isDefined(raw.mapping) ? Guard.oneOf(raw.mapping, Mappings, `${path}.mapping`) : "linear"
                if (mapping === "exp" && min <= 0.0) {
                    return panic(new RangeError(`${path}: mapping "exp" needs min above 0`))
                }
                if (mapping === "int" && !(Number.isInteger(min) && Number.isInteger(max))) {
                    return panic(new RangeError(`${path}: mapping "int" needs whole numbers for min and max`))
                }
                return {
                    type, label, min, max, mapping,
                    value: within(raw.value, min, max, path),
                    step: step(raw.step, path),
                    unit: unit(raw.unit, path)
                }
            }
            case "dropdown": {
                if (!Array.isArray(raw.options) || raw.options.length === 0) {
                    return panic(new TypeError(`${path}.options: expected a list with at least one option`))
                }
                const options: ReadonlyArray<DialogOption> = raw.options.map((option: unknown, index: number) => {
                    const entry = record(option, `${path}.options[${index}]`)
                    return {
                        label: Guard.string(entry.label, `${path}.options[${index}].label`),
                        value: choice(entry.value, `${path}.options[${index}].value`)
                    }
                })
                const selected = choice(raw.value, `${path}.value`)
                if (!options.some(option => option.value === selected)) {
                    return panic(new RangeError(`${path}.value: ${Guard.describe(selected)} is not the value of an option`))
                }
                return {type, label, value: selected, options}
            }
        }
    }

    const record = (value: unknown, path: string): Raw => {
        if (typeof value !== "object" || isNull(value) || Array.isArray(value)) {
            return panic(new TypeError(`${path}: expected an object, got ${Guard.describe(value)}`))
        }
        return value as Raw
    }

    const optional = (value: unknown, path: string): Optional<number> =>
        isDefined(value) ? Guard.finite(value, path) : undefined

    const within = (value: unknown, min: number, max: number, path: string): number => {
        const result = Guard.finite(value, `${path}.value`)
        if (result < min || result > max) {
            return panic(new RangeError(`${path}.value: ${result} is not within min and max`))
        }
        return result
    }

    const step = (value: unknown, path: string): Optional<number> => {
        if (!isDefined(value)) {return undefined}
        const result = Guard.finite(value, `${path}.step`)
        if (result <= 0.0) {return panic(new RangeError(`${path}.step: ${result} must be positive`))}
        return result
    }

    const unit = (value: unknown, path: string): Optional<string> =>
        isDefined(value) ? Guard.string(value, `${path}.unit`) : undefined

    const choice = (value: unknown, path: string): string | number =>
        typeof value === "string" ? value : Guard.finite(value, path)
}
