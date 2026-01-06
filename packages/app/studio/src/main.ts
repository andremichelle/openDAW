import "./main.sass"
import workersUrl from "@opendaw/studio-core/workers-main.js?worker&url"
import workletsUrl from "@opendaw/studio-core/processors.js?url"
import { boot } from "@/boot"
import { initializeColors } from "@opendaw/studio-enums"

if (window.crossOriginIsolated) {
    const now = Date.now()
    initializeColors(document.documentElement)
    boot({ workersUrl, workletsUrl })
        .then(() => console.debug(`Booted in ${Math.ceil(Date.now() - now)}ms`))
        .catch(err => {
            console.error("Boot failure", err)
            alert("Boot failure: " + err.message)
        })
} else {
    alert("crossOriginIsolated must be enabled")
}