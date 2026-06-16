import "./style.sass"
import {replaceChildren} from "@opendaw/lib-jsx"
import {initializeColors} from "@opendaw/studio-enums"
import {App} from "./App"

initializeColors(document.documentElement)
replaceChildren(document.body, App())
