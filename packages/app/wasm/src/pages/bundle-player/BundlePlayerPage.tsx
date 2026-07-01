import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {MutableObservableOption, Terminator, UUID} from "@opendaw/lib-std"
import {DeviceBox, DeviceBoxUtils} from "@opendaw/studio-adapters"
import {Env} from "../../Env"
import {createEngineHost} from "../../engine-host"
import {decodeBundle} from "../../bundle"
import {SampleStorage} from "../../sample-storage"

// Loads an openDAW BUNDLE (.odb) chosen from disk and plays it. The bundle carries the project box graph AND its
// sample assets; we decode it, write every sample into the persistent SampleStorage cache (so the engine resolves
// them locally, no network), then boot the shared engine host on the extracted box graph. Switching files disposes
// the running engine and boots the new one.
const deviceLabel = (device: DeviceBox): string => {
    const label = device.label.getValue()
    return label.length > 0 ? label : device.name
}

export const BundlePlayerPage: PageFactory<Env> = ({lifecycle}) => {
    const status: HTMLParagraphElement = <p>Choose an <code>.odb</code> bundle to play.</p>
    const host: HTMLDivElement = <div/>
    const plugins: HTMLDivElement = <div/>
    const logs: HTMLDivElement = <div/>
    const current = new MutableObservableOption<Terminator>()
    const play = async (file: File): Promise<void> => {
        current.ifSome(terminator => terminator.terminate())
        host.replaceChildren()
        plugins.replaceChildren()
        logs.replaceChildren()
        status.textContent = `Decoding ${file.name}…`
        const bundle = await decodeBundle(await file.arrayBuffer())
        // Cache every sample the bundle carries, so the engine's cache-first loader resolves them locally.
        status.textContent = `Caching ${bundle.samples.length} sample(s)…`
        await Promise.all(bundle.samples.map(({uuid, wav}) => SampleStorage.writeAudio(uuid, wav)))
        const terminator = lifecycle.spawn()
        current.wrap(terminator)
        const engine = createEngineHost(bundle.boxGraph, terminator, {channel: `bundle-player-${UUID.toString(bundle.uuid ?? UUID.Lowest)}`})
        host.append(engine.element)
        logs.append(engine.log)
        engine.append(`bundle: ${bundle.samples.length} sample(s) cached to OPFS (${SampleStorage.Folder})`)
        const devices = bundle.boxGraph.boxes().filter(DeviceBoxUtils.isDeviceBox)
            .sort((left, right) => deviceLabel(left).localeCompare(deviceLabel(right)))
        if (devices.length > 0) {
            plugins.append(<div className="plugin-list"><h3>Devices</h3>
                {devices.map(device => <label className="plugin-row"><span>{deviceLabel(device)}</span></label>)}</div>)
        }
        status.textContent = `Loaded ${file.name} — ${bundle.samples.length} sample(s), ${devices.length} device(s). Press Play.`
    }
    const input: HTMLInputElement = <input type="file" accept=".odb"/>
    input.onchange = () => {
        const file = input.files?.[0]
        if (file === undefined) {return}
        play(file).catch(reason => {status.textContent = `Failed: ${reason instanceof Error ? reason.message : String(reason)}`})
    }
    return (
        <div className="page">
            <h2>Bundle Player</h2>
            <p>Loads an openDAW bundle (a <code>.odb</code> file: the project plus its samples) into the wasm engine.
                The samples are cached in OPFS (<code>{SampleStorage.Folder}</code>) so a re-open needs no network.</p>
            <div className="metro-controls">
                <label>Bundle </label>
                {input}
            </div>
            {host}
            {plugins}
            {status}
            {logs}
        </div>
    )
}
