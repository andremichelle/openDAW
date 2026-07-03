// A dedicated Web Worker that decodes an .odb and renders it front-to-end through BOTH engines OFFLINE, so the
// heavy render loop never blocks the main thread (the WASM analog of the studio's worker-based
// OfflineEngineRenderer). It receives the raw bundle bytes + the render length, runs the WASM render then the TS
// render, and transfers the two stereo masters + their render-loop times back to the page.
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {decodeBundle} from "../bundle"
import {disableLoopArea, registerScriptDevices, renderTsOffline, renderWasmOffline} from "./offline-render"
import type {OfflineResult} from "./result"

export type RenderRequest = {odb: ArrayBuffer, quanta: number, sampleRate: number}
type ResultMessage = {left: Float32Array, right: Float32Array, renderMs: number, sampleRate: number}
export type RenderResponse =
    | {type: "progress", message: string}
    | {type: "done", wasm: ResultMessage, ts: ResultMessage}
    | {type: "error", message: string}

const strip = (result: OfflineResult): ResultMessage =>
    ({left: result.left, right: result.right, renderMs: result.renderMs, sampleRate: result.sampleRate})

const post = (message: RenderResponse, transfer?: Transferable[]): void =>
    (self as unknown as Worker).postMessage(message, transfer ?? [])

self.onmessage = async (event: MessageEvent<RenderRequest>): Promise<void> => {
    const {odb, quanta, sampleRate} = event.data
    try {
        const bundle = await decodeBundle(odb)
        // Render the whole arrangement, not a looped section: disable the loop area on the graph (WASM syncs it)
        // and re-encode the project from the mutated graph (the TS engine reads that).
        disableLoopArea(bundle.boxGraph)
        // Register the project's scriptable-device scripts (Werkstatt/Apparat/Spielwerk) into the shared worklet
        // registry BOTH engines read (globalThis.openDAW). Without them the script bridge outputs silence, muting
        // every chain those devices sit on — the whole cause of "Open Up" rendering silent in both engines.
        registerScriptDevices(bundle.boxGraph)
        bundle.project = ProjectSkeleton.encode(bundle.boxGraph) as ArrayBuffer
        post({type: "progress", message: `Rendering WASM (${quanta} quanta)…`})
        const wasm = await renderWasmOffline(bundle, quanta, sampleRate)
        post({type: "progress", message: `WASM ${wasm.renderMs.toFixed(1)} ms. Rendering TS…`})
        const ts = await renderTsOffline(bundle, quanta, sampleRate)
        post({type: "done", wasm: strip(wasm), ts: strip(ts)},
            [wasm.left.buffer, wasm.right.buffer, ts.left.buffer, ts.right.buffer])
    } catch (error) {
        post({type: "error", message: error instanceof Error ? error.message : String(error)})
    }
}
