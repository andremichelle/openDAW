import {panic} from "@moises-ai/lib-std"

export namespace CssUtils {
    export const calc = (term: string, size: number, em: number): number => {
        const regex = /([0-9]*\.?[0-9]+)([a-zA-Z%]*)/g
        let result = term
        result.split(/\+|(?<!\d)-/)
            .flatMap(result => Array.from(result.matchAll(regex)))
            .forEach(([replace, digits, unit]) => {
                const number = parseFloat(digits)
                if (isNaN(number)) {return panic(`${replace} does not contain a number`)}
                if (unit === "em") {
                    result = result.replaceAll(replace, `${number * em}`)
                } else if (unit === "%") {
                    result = result.replaceAll(replace, `${number / 100.0 * size}`)
                } else if (unit === "px") {
                    result = result.replaceAll(replace, `${number}`)
                } else {
                    return panic(`Unknown unit '${unit}'`)
                }
            })
        return Function(`return ${result}`)()
    }

    const customCursors: Map<number, string> = new Map()

    export const registerCustomCursor = (identifier: number, data: string) => customCursors.set(identifier, data)

    export const setCursor = (identifier: CssUtils.Cursor | number, doc: Document = document) => {
        doc.documentElement.style.cursor = typeof identifier === "number"
            ? customCursors.get(identifier) ?? "auto"
            : identifier
    }

    export type Cursor =
        | "alias"
        | "all-scroll"
        | "auto"
        | "cell"
        | "context-menu"
        | "col-resize"
        | "copy"
        | "crosshair"
        | "default"
        | "e-resize"
        | "ew-resize"
        | "grab"
        | "grabbing"
        | "help"
        | "move"
        | "n-resize"
        | "ne-resize"
        | "nesw-resize"
        | "ns-resize"
        | "nw-resize"
        | "nwse-resize"
        | "no-drop"
        | "none"
        | "not-allowed"
        | "pointer"
        | "progress"
        | "row-resize"
        | "s-resize"
        | "se-resize"
        | "sw-resize"
        | "text"
        | "url"
        | "w-resize"
        | "wait"
        | "zoom-in"
        | "zoom-out"
}