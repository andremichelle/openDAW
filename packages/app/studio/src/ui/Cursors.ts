import {asDefined} from "@moises-ai/lib-std"
import {IconSymbol} from "@moises-ai/studio-enums"
import {CssUtils} from "@moises-ai/lib-dom"

const iconSymbolToCursor = (symbol: IconSymbol, hotspotX: number, hotspotY: number, fallback: CssUtils.Cursor = "auto") => {
    const cursor: Element = asDefined(document.getElementById(
        IconSymbol.toName(symbol)), `Could not find ${IconSymbol.toName(symbol)}`)
        .cloneNode(true) as Element
    cursor.removeAttribute("id")
    cursor.setAttribute("xmlns", "http://www.w3.org/2000/svg")
    cursor.setAttribute("width", "20")
    cursor.setAttribute("height", "20")
    cursor.setAttribute("stroke", "black")
    return `url('data:image/svg+xml,${encodeURI(cursor.outerHTML
        .replace("<symbol ", "<svg ")
        .replace("</symbol>", "</svg>")
        .replace("currentColor", "white"))}') ${hotspotX} ${hotspotY}, ${fallback}`
}

export const enum Cursor {
    Pencil, Scissors, ExpandWidth
}

export const installCursors = () => {
    CssUtils.registerCustomCursor(Cursor.Pencil, iconSymbolToCursor(IconSymbol.Pencil, 3, 16, "pointer"))
    CssUtils.registerCustomCursor(Cursor.ExpandWidth, iconSymbolToCursor(IconSymbol.ExpandWidth, 10, 10, "col-resize"))
    CssUtils.registerCustomCursor(Cursor.Scissors, iconSymbolToCursor(IconSymbol.Scissors, 10, 10, "auto"))
}