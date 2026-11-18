import {Xml} from "@opendaw/lib-xml"

export namespace DawCodecs {
    const parse = (value: string): number => {
        const trimmed = value.trim()
        if (trimmed === "inf" || trimmed === "+inf" || trimmed === "Infinity") {return Number.POSITIVE_INFINITY}
        if (trimmed === "-inf" || trimmed === "-Infinity") {return Number.NEGATIVE_INFINITY}
        return Xml.parseDouble(trimmed)
    }

    const format = (value: number): string => {
        if (value === Number.POSITIVE_INFINITY) {return "inf"}
        if (value === Number.NEGATIVE_INFINITY) {return "-inf"}
        return Xml.formatDouble(value)
    }

    export const DoubleRequired: Xml.Codec<number> = Xml.codec(true, parse, format)
    export const DoubleOptional: Xml.Codec<number> = Xml.codec(false, parse, format)
}
