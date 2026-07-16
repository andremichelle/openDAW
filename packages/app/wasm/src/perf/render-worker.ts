// A dedicated Web Worker that decodes an .odb and renders it front-to-end OFFLINE, so the heavy render loop
// never blocks the main thread (the WASM analog of the studio's worker-based OfflineEngineRenderer). It
// receives the raw bundle bytes + the render length and transfers the stereo master + its render-loop time
// back to the page.
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {decodeBundle} from "../bundle"
import {disableLoopArea, registerScriptDevices, renderWasmOffline} from "./offline-render"
import type {OfflineResult} from "./result"

export type RenderRequest = {odb: ArrayBuffer, quanta: number, sampleRate: number}
type ResultMessage = {left: Float32Array<ArrayBuffer>, right: Float32Array<ArrayBuffer>, renderMs: number, sampleRate: number}
export type RenderResponse =
    | {type: "progress", message: string}
    | {type: "done", wasm: ResultMessage}
    | {type: "error", message: string}

const strip = (result: OfflineResult): ResultMessage =>
    ({left: result.left, right: result.right, renderMs: result.renderMs, sampleRate: result.sampleRate})

const post = (message: RenderResponse, transfer?: Transferable[]): void =>
    (self as unknown as Worker).postMessage(message, transfer ?? [])

self.onmessage = async (event: MessageEvent<RenderRequest>): Promise<void> => {
    const {odb, quanta, sampleRate} = event.data
    try {
        const bundle = await decodeBundle(odb)
        // Render the whole arrangement, not a looped section: disable the loop area on the graph (the engine
        // syncs it) and re-encode the project from the mutated graph.
        disableLoopArea(bundle.boxGraph)
        // Register the project's scriptable-device scripts (Werkstatt/Apparat/Spielwerk) into the worklet
        // registry the engine reads (globalThis.openDAW). Without them the script bridge outputs silence, muting
        // every chain those devices sit on.
        registerScriptDevices(bundle.boxGraph)
        bundle.project = ProjectSkeleton.encode(bundle.boxGraph) as ArrayBuffer
        post({type: "progress", message: `Rendering (${quanta} quanta)…`})
        const wasm = await renderWasmOffline(bundle, quanta, sampleRate)
        post({type: "done", wasm: strip(wasm)}, [wasm.left.buffer, wasm.right.buffer])
    } catch (error) {
        post({type: "error", message: error instanceof Error ? error.message : String(error)})
    }
}
