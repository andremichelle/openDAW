import "./style.sass"
import {createElement, Frag, replaceChildren} from "@opendaw/lib-jsx"
import {isRecord, Terminator, tryCatch} from "@opendaw/lib-std"
import {ColorScheme, DefaultColorScheme, initializeColors, setColorScheme} from "@opendaw/studio-enums"
import {loadFont} from "@opendaw/lib-dom"
import {IconLibrary} from "@opendaw/studio-icons"
import {App} from "./App"
import {ToastLayer} from "./Toast"

const readColorScheme = (): ColorScheme => {
    const {status, value} = tryCatch(() => JSON.parse(localStorage.getItem("preferences") ?? "{}"))
    if (status === "failure" || !isRecord(value) || !isRecord(value.appearance)) {return DefaultColorScheme}
    const {"neutral-hue": hue, "neutral-saturation": saturation} = value.appearance
    return typeof hue === "number" && typeof saturation === "number"
        ? {hue, saturation: saturation / 100.0} : DefaultColorScheme
}
setColorScheme(readColorScheme())
initializeColors(document.documentElement)
await Promise.all([
    loadFont({"font-family": "Rubik", "font-weight": 300, "font-style": "normal", "src": "/manuals/fonts/rubik-300.woff2"}),
    loadFont({"font-family": "Rubik", "font-weight": 400, "font-style": "normal", "src": "/manuals/fonts/rubik-400.woff2"})
])
const terminator = new Terminator()
replaceChildren(document.body, (
    <Frag>
        <IconLibrary/>
        {App(terminator)}
        <ToastLayer/>
    </Frag>
))
