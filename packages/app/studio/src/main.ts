import "./main.sass"
import mobileCss from "./mobile.sass?inline"
import workersUrl from "@opendaw/studio-core/workers-main.js?worker&url"
import workletsUrl from "@opendaw/studio-core/processors.js?url"
import wasmProcessorUrl from "@opendaw/studio-core-wasm/wasm-processor.js?url"
import wasmOfflineWorkerUrl from "@opendaw/studio-core-wasm/wasm-offline-worker.js?worker&url"
import {boot} from "@/boot"
import {initializeColors} from "@opendaw/studio-enums"
import {Browser, Html} from "@opendaw/lib-dom"

if (Browser.isMobile()) {
    const className = Html.adoptStyleSheet(mobileCss, "Mobile")
    document.body.innerHTML = `<div class="${className}">
        <div>
            <img class="logo" src="/favicon.svg" alt="openDAW logo">
            <h1>openDAW</h1>
            <p class="claim">Create Music Online</p>
            <img class="screenshot" src="/images/studio-meta.jpg" alt="The openDAW Studio timeline, devices and mixer running in a web browser.">
            <p>Hey there, thanks for stopping by!</p>
            <p>openDAW is a full music studio and needs the screen space of a computer, so it does not run on your phone.</p>
            <p>It is well worth coming back on a desktop or laptop browser. See you there!</p>
        </div>
    </div>`
} else if (window.crossOriginIsolated) {
    const now = Date.now()
    initializeColors(document.documentElement)
    boot({
        workersUrl,
        workletsUrl,
        wasmProcessorUrl,
        wasmOfflineWorkerUrl
    }).then(() => console.debug(`Booted in ${Math.ceil(Date.now() - now)}ms`))
} else {
    alert("crossOriginIsolated must be enabled")
}