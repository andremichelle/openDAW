import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Env} from "../../Env"
import {createEngineHost} from "../../engine-host"

// Loads a SERIALIZED openDAW project straight into the wasm engine instead of building the box
// graph in code: fetch the bytes, `ProjectSkeleton.decode` them into a box graph, and stream it through the
// unchanged `SyncSource` (the same path every other page uses). The project contains a single Vaporisateur
// instrument on one note track, with the preset baked into the file, so it plays with no patching here.
const PROJECT_OD_FILE = "/nano.od"

export const LoadFilePage: PageFactory<Env> = ({lifecycle}) => {
    const status: HTMLParagraphElement = <p>Loading <code>{PROJECT_OD_FILE}</code>…</p>
    const controls: HTMLDivElement = <div/>
    const logs: HTMLDivElement = <div/>
    const load = async (): Promise<void> => {
        const arrayBuffer = await fetch(PROJECT_OD_FILE).then(response => response.arrayBuffer())
        const {boxGraph} = ProjectSkeleton.decode(arrayBuffer)
        const host = createEngineHost(boxGraph, lifecycle, {channel: "load-file-sync"})
        status.textContent = `Loaded ${PROJECT_OD_FILE}`
        controls.append(host.element)
        logs.append(host.log)
    }
    void load()
    return (
        <div className="page">
            <h2>Load File</h2>
            <p>Loads a serialized openDAW project <code>{PROJECT_OD_FILE}</code> into the wasm engine
                via <code>ProjectSkeleton.decode</code>.</p>
            {controls}
            {status}
            {logs}
        </div>
    )
}
