import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {MutableObservableOption, Terminator} from "@opendaw/lib-std"
import {DeviceBox, DeviceBoxUtils, ProjectSkeleton} from "@opendaw/studio-adapters"
import {Env} from "../../Env"
import {createEngineHost} from "../../engine-host"

// Loads a SERIALIZED openDAW project straight into the wasm engine instead of building the box graph in code:
// fetch the bytes, `ProjectSkeleton.decode` them into a box graph, and stream it through the unchanged
// `SyncSource` (the same path every other page uses). The dropdown lists every project under public/projects;
// switching disposes the whole engine (its own child lifecycle) and boots a fresh one for the new file.
const FILES = import.meta.glob("/public/projects/*.od", {query: "?url", import: "default"})
const PROJECTS = Object.keys(FILES)
    .map(path => ({
        name: path.slice(path.lastIndexOf("/") + 1).replace(/\.od$/, ""),
        url: path.replace(/^\/public/, "")
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

// A device's display name: its user `label`, falling back to the box class name when the label is unset.
const deviceLabel = (device: DeviceBox): string => {
    const label = device.label.getValue()
    return label.length > 0 ? label : device.name
}

export const LoadFilePage: PageFactory<Env> = ({lifecycle}) => {
    const status: HTMLParagraphElement = <p/>
    const host: HTMLDivElement = <div/>
    const plugins: HTMLDivElement = <div/>
    const logs: HTMLDivElement = <div/>
    const current = new MutableObservableOption<Terminator>()
    const load = async (url: string): Promise<void> => {
        current.ifSome(terminator => terminator.terminate())
        host.replaceChildren()
        plugins.replaceChildren()
        logs.replaceChildren()
        const terminator = lifecycle.spawn()
        current.wrap(terminator)
        status.textContent = "Loading…"
        const arrayBuffer = await fetch(url).then(response => response.arrayBuffer())
        const {boxGraph} = ProjectSkeleton.decode(arrayBuffer)
        const engine = createEngineHost(boxGraph, terminator, {channel: "load-file-sync"})
        host.append(engine.element)
        logs.append(engine.log)
        // Every plugin (instrument + audio / midi effect) in this project, each with a checkbox bound to its
        // `enabled` field. Toggling runs a box-graph transaction, which streams through the SAME SyncSource as
        // every other edit, so the engine bypasses / re-wires the device edge-only (no rebuild, no param reset).
        const devices = boxGraph.boxes().filter(DeviceBoxUtils.isDeviceBox)
            .sort((left, right) => deviceLabel(left).localeCompare(deviceLabel(right)))
        if (devices.length > 0) {
            const rows = devices.map(device => {
                const checkbox: HTMLInputElement = <input type="checkbox"/>
                checkbox.onchange = () => {
                    boxGraph.beginTransaction()
                    device.enabled.setValue(checkbox.checked)
                    boxGraph.endTransaction()
                }
                terminator.own(device.enabled.catchupAndSubscribe(field => checkbox.checked = field.getValue()))
                return <label className="plugin-row">{checkbox}<span>{deviceLabel(device)}</span></label>
            })
            plugins.append(<div className="plugin-list"><h3>Plugins</h3>{rows}</div>)
        }
        status.textContent = `Loaded ${PROJECTS.find(project => project.url === url)?.name ?? url}`
    }
    const select: HTMLSelectElement = (
        <select onchange={(event: Event) => void load((event.target as HTMLSelectElement).value)}>
            {PROJECTS.map(project => <option value={project.url}>{project.name}</option>)}
        </select>
    )
    if (PROJECTS.length > 0) {void load(PROJECTS[0].url)}
    return (
        <div className="page">
            <h2>Load File</h2>
            <p>Loads a serialized openDAW project (a <code>.od</code> file from <code>public/projects</code>) into
                the wasm engine via <code>ProjectSkeleton.decode</code>. Switching disposes the engine and boots
                the new file.</p>
            <div className="metro-controls">
                <label>Project </label>
                {select}
            </div>
            {host}
            {plugins}
            {status}
            {logs}
        </div>
    )
}
