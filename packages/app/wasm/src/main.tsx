import "./style.sass"
import {replaceChildren} from "@opendaw/lib-jsx"
import {initializeColors} from "@opendaw/studio-enums"
import {App} from "./App"

// Surface any uncaught error / rejected promise in an alert (these test pages have no error UI).
window.addEventListener("error", (event: ErrorEvent) => alert(`Error: ${event.message}`))
window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason = event.reason
    alert(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`)
})

initializeColors(document.documentElement)
replaceChildren(document.body, App())
