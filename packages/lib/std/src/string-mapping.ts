import {int, isDefined, Nullable, unitValue} from "./lang"
import {clamp} from "./math"

export type StringResult = {
    value: string
    unit: string
}

export type ParseResult<T> =
    | { type: "unknown", value: string }
    | { type: "unitValue", value: unitValue }
    | { type: "explicit", value: T }

export interface StringMapping<T> {
    y(x: string): ParseResult<T>
    x(y: T): StringResult
}

export namespace StringMapping {
    export type NumericOptions = {
        unit?: string
        fractionDigits?: int
        unitPrefix?: boolean
        bipolar?: boolean
    }
    export const percent =
        ({bipolar, fractionDigits}: NumericOptions = {}): StringMapping<number> =>
            new Numeric("%", fractionDigits, false, bipolar)
    export const numeric =
        ({unit, fractionDigits, unitPrefix, bipolar}: NumericOptions = {}): StringMapping<number> =>
            new Numeric(unit, fractionDigits, unitPrefix, bipolar)
    export const indices = (unit: string, values: ReadonlyArray<string>): StringMapping<int> =>
        new class implements StringMapping<int> {
            x(y: int): StringResult {
                return {unit, value: values[y]}
            }
            y(x: string): ParseResult<int> {
                const index = values.indexOf(x)
                return index === -1 ? {type: "unknown", value: "💣"} : {type: "explicit", value: index}
            }
        }
    export const values = <T>(unit: string, values: ReadonlyArray<T>, strings: ReadonlyArray<string>): StringMapping<T> =>
        new class implements StringMapping<T> {
            x(y: T): StringResult {
                return {unit, value: strings.at(values.indexOf(y)) ?? "N/A"}
            }
            y(x: string): ParseResult<T> {
                const index = strings.indexOf(x)
                return index === -1 ? {type: "unknown", value: "💣"} : {type: "explicit", value: values[index]}
            }
        }

    export const bool = new class implements StringMapping<boolean> {
        y(x: string): ParseResult<boolean> {
            switch (x.trim()) {
                case "on":
                case "yes":
                case "true":
                    return {type: "explicit", value: true}
                default:
                    return {type: "explicit", value: false}
            }
        }
        x(y: boolean): StringResult {
            return {value: y ? "On" : "Off", unit: ""}
        }
    }

    export const boolValues = (falseValue: string, trueValue: string) => new class implements StringMapping<boolean> {
        y(x: string): ParseResult<boolean> {
            switch (x.trim()) {
                case trueValue:
                case "on":
                case "yes":
                case "true":
                    return {type: "explicit", value: true}
                case falseValue:
                default:
                    return {type: "explicit", value: false}
            }
        }
        x(y: boolean): StringResult {
            return {value: y ? "On" : "Off", unit: ""}
        }
    }

    class Numeric implements StringMapping<number> {
        readonly #unit: string
        readonly #fractionDigits: int
        readonly #unitPrefix: boolean
        readonly #bipolar: boolean

        constructor(unit?: string, fractionDigits?: int, unitPrefix?: boolean, bipolar?: boolean) {
            this.#unit = unit ?? ""
            this.#fractionDigits = fractionDigits ?? 0
            this.#unitPrefix = unitPrefix ?? false
            this.#bipolar = bipolar ?? false
        }

        y(x: string): ParseResult<number> {
            let value = x.trim()
            const float = parseFloat(value)
            if (isNaN(float)) {
                return {type: "unknown", value: value}
            } else if (this.#unit === "%") {
                return {
                    type: "explicit",
                    value: float / 100.0
                }
            } else if (value.endsWith("%")) {
                return {
                    type: "unitValue",
                    value: this.#bipolar
                        ? clamp(float / 200.0 + 0.5, 0.0, 1.0)
                        : clamp(float / 100.0, 0.0, 1.0)
                }
            } else {
                if (value.endsWith(this.#unit) && this.#unit.length > 0) {
                    // remove unit
                    value = value.slice(0, -this.#unit.length)
                }
                const regex = /(\d+)(\D+)/
                const match: Nullable<RegExpExecArray> = regex.exec(value)
                const last = match?.at(2)?.at(0)
                if (isDefined(last)) {
                    const index: int = prefixes.indexOf(last)
                    if (index > -1) {
                        return {type: "explicit", value: float * Math.pow(10.0, (index - 4) * 3.0)}
                    }
                }
                return {type: "explicit", value: float}
            }
        }
        x(y: number): StringResult {
            if (Number.isNaN(y)) {
                return {value: "💣", unit: this.#unit}
            } else if (Number.isFinite(y)) {
                if (this.#unit === "%") {
                    return this.#bipolar
                        ? {value: (y * 200 - 100).toFixed(this.#fractionDigits), unit: this.#unit}
                        : {value: (y * 100).toFixed(this.#fractionDigits), unit: this.#unit}
                }
                if (this.#unitPrefix) {
                    const {value, prefix} = computePrefix(y)
                    return {value: value.toFixed(this.#fractionDigits), unit: `${prefix}${this.#unit}`}
                } else {
                    return {value: y.toFixed(this.#fractionDigits), unit: this.#unit}
                }
            } else {
                return {value: y === Number.POSITIVE_INFINITY ? "∞" : "-∞", unit: this.#unit}
            }
        }
    }

    const prefixes: ReadonlyArray<string> = Object.freeze(["p", "n", "μ", "m", "", "k", "M", "G", "T"] as const)
    // this magic number rounds the result perfectly to integers, while the mathematically correct 10 doesn't:
    // computeBase10(1000) = 3
    // computeBase10(0.001) = -3
    const computeBase10 = (value: number): int => Math.log(value) / Math.log(9.999999999999999)
    const computePrefix = (value: number): { value: number, prefix: string } => {
        const location = Math.floor(computeBase10(value) / 3.0)
        const prefix = prefixes[location + 4]
        return isDefined(prefix) ? {value: value * Math.pow(10.0, location * -3.0), prefix} : {value, prefix: ""}
    }

    export const decible = StringMapping.numeric({unit: "db", fractionDigits: 2})
    export const panning = StringMapping.percent({unit: "%", fractionDigits: 0})
}