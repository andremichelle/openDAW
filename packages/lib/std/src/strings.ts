import {isDefined, Maybe} from "./lang"

export namespace Strings {
    export const hyphenToCamelCase = (value: string) => value
        .replace(/-([a-z])/g, (g: string) => g[1].toUpperCase())

    export const nonEmpty = (str: Maybe<string>): str is string => isDefined(str) && str.trim().length > 0

    export const fallback = (value: Maybe<string>, fallback: string): string => nonEmpty(value) ? value : fallback

    export const endsWithDigit = (str: string): boolean => /\d$/.test(str)

    // UTF-8
    export const toArrayBuffer = (str: string): ArrayBuffer => {
        const buffer = new ArrayBuffer(str.length)
        const view = new Uint8Array(buffer)
        for (let i = 0; i < str.length; i++) {
            view[i] = str.charCodeAt(i)
        }
        return buffer
    }

    // Returns desiredName if free, otherwise appends/increments a numeric suffix
    // until unique. A trailing " <number>" in desiredName is treated as the
    // counter, so getUniqueName(["Foo 2"], "Foo 2") yields "Foo 3", not "Foo 2 2".
    export const getUniqueName = (existingNames: ReadonlyArray<string>, desiredName: string): string => {
        const existing = new Set(existingNames)
        if (!existing.has(desiredName)) {return desiredName}
        const match = desiredName.match(/^(.*\S)\s+(\d+)$/)
        const base = isDefined(match) ? match[1] : desiredName
        let counter = isDefined(match) ? parseInt(match[2], 10) + 1 : 2
        let candidate = `${base} ${counter}`
        while (existing.has(candidate)) {candidate = `${base} ${++counter}`}
        return candidate
    }
}