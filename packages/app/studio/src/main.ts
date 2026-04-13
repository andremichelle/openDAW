import "./main.sass"
import workersUrl from "@moises-ai/studio-core/workers-main.js?worker&url"
import workletsUrl from "@moises-ai/studio-core/processors.js?url"
import offlineEngineUrl from "@moises-ai/studio-core/offline-engine.js?worker&url"
import {boot} from "@/boot"
import {initializeColors} from "@moises-ai/studio-enums"
import {Browser} from "@moises-ai/lib-dom"

if (Browser.isMobile()) {
    document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;padding:2em;text-align:center;font-family:system-ui;color:#ccc;background:#1a1a1a">
        <div><h1>openDAW</h1><p>openDAW requires a desktop browser.<br>Please visit on a computer.</p></div>
    </div>`
} else if (window.crossOriginIsolated) {
    const now = Date.now()
    initializeColors(document.documentElement)
    boot({
        workersUrl,
        workletsUrl,
        offlineEngineUrl
    }).then(() => console.debug(`Booted in ${Math.ceil(Date.now() - now)}ms`))
} else {
    alert("crossOriginIsolated must be enabled")
}