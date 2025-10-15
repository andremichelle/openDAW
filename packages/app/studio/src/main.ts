import "./main.sass"

import workersUrl from "@opendaw/studio-core/workers-main.js?worker&url"
import workletsUrl from "@opendaw/studio-core/processors.js?url"
import {boot} from "@/boot"

if (window.crossOriginIsolated) {
    const now = Date.now()
    boot({workersUrl, workletsUrl}).then(() => console.debug(`Booted in ${Math.ceil(Date.now() - now)}ms`))
} else {
    alert("crossOriginIsolated is enabled")
}