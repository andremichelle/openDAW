import "./main.sass"
import workersUrl from "@moises-ai/studio-core/workers-main.js?worker&url"
import workletsUrl from "@moises-ai/studio-core/processors.js?url"
import offlineEngineUrl from "@moises-ai/studio-core/offline-engine.js?worker&url"
import {boot} from "@/boot"
import {initializeColors} from "@moises-ai/studio-enums"

if (window.crossOriginIsolated) {
    const now = Date.now()
    initializeColors(document.documentElement)
    boot({workersUrl, workletsUrl, offlineEngineUrl}).then(() => console.debug(`Booted in ${Math.ceil(Date.now() - now)}ms`))
} else {
    alert("crossOriginIsolated must be enabled")
}