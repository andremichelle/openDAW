import "./style.sass"
import {createElement, Frag, replaceChildren} from "@opendaw/lib-jsx"
import {Terminator} from "@opendaw/lib-std"
import {initializeColors} from "@opendaw/studio-enums"
import {loadFont} from "@opendaw/lib-dom"
import {IconLibrary} from "@opendaw/studio-icons"
import {App} from "./App"

initializeColors(document.documentElement)
const terminator = new Terminator()
replaceChildren(document.body, (
    <Frag>
        <IconLibrary/>
        {App(terminator)}
    </Frag>
))
loadFont({"font-family": "Rubik", "font-weight": 300, "font-style": "normal", "src": "/fonts/rubik-300.woff2"})
loadFont({"font-family": "Rubik", "font-weight": 400, "font-style": "normal", "src": "/fonts/rubik-400.woff2"})
