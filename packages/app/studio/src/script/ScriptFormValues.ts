import {clamp, int, isDefined, Optional, StringMapping, ValueGuard, ValueMapping} from "@opendaw/lib-std"
import {DialogNumber, DialogSlider} from "@opendaw/studio-scripting"

export namespace ScriptFormValues {
    const MaxDigits = 6

    export type Numeric = {
        guard: ValueGuard<number>
        mapper: StringMapping<number>
        maxChars: int
        step: number
        decimal: boolean
    }

    export const digitsOf = (step: number): int => {
        for (let digits = 0; digits < MaxDigits; digits++) {
            const scaled = step * 10 ** digits
            if (Math.abs(scaled - Math.round(scaled)) < 1e-9) {return digits}
        }
        return MaxDigits
    }

    export const number = ({value, min, max, step}: DialogNumber): Numeric => {
        const low = min ?? Number.NEGATIVE_INFINITY
        const high = max ?? Number.POSITIVE_INFINITY
        const digits = isDefined(step) ? digitsOf(step) : MaxDigits
        const format = (value: number): string => isDefined(step) ? value.toFixed(digits) : String(round(value, digits))
        return {
            guard: createGuard(low, high, min ?? 0.0, step, digits),
            mapper: createMapper(format),
            maxChars: isDefined(min) && isDefined(max)
                ? Math.max(format(min).length, format(max).length)
                : Math.max(8, format(value).length + 2),
            step: step ?? 1.0,
            decimal: digits > 0
        }
    }

    export const slider = ({min, max, step, mapping}: DialogSlider): Numeric & { mapping: ValueMapping<number> } => {
        const exponential = mapping === "exp"
        const snap = step ?? (mapping === "int" ? 1.0 : undefined)
        const digits = isDefined(snap)
            ? digitsOf(snap)
            : clamp(2 - Math.floor(Math.log10(exponential ? min : max - min)), 0, MaxDigits)
        const format = (value: number): string => value.toFixed(digits)
        return {
            guard: createGuard(min, max, min, snap, digits),
            mapper: createMapper(format),
            maxChars: Math.max(format(min).length, format(max).length),
            step: snap ?? 10 ** -digits,
            decimal: digits > 0,
            mapping: exponential ? ValueMapping.exponential(min, max) : ValueMapping.linear(min, max)
        }
    }

    const round = (value: number, digits: int): number => Number(value.toFixed(digits))

    const createGuard = (min: number, max: number, base: number, step: Optional<number>, digits: int): ValueGuard<number> => ({
        guard: (value: number): number => clamp(isDefined(step)
            ? round(base + Math.round((value - base) / step) * step, digits)
            : round(value, digits), min, max)
    })

    const createMapper = (format: (value: number) => string): StringMapping<number> => ({
        x: (value: number) => ({value: format(value), unit: ""}),
        y: (text: string) => {
            const value = parseFloat(text.trim().replace(",", "."))
            return Number.isFinite(value) ? {type: "explicit", value} : {type: "unknown", value: text}
        }
    })
}
