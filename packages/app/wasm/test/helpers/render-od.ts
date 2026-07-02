// A Rust-side offline renderer for a serialized .od project — the counterpart to the studio's TS
// OfflineEngineRenderer. It decodes the project, boots the real engine + every device side-module, streams the
// box graph in, LOADS ITS ASSETS (samples), and renders N seconds of interleaved stereo, returning the audio.
// Use it to compare a project's Rust output against the TS engine (or against a per-device reference).
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {ApparatDeviceBox, AudioFileBox, SpielwerkDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {loadFullEngine} from "./load-full-engine"
import {connectSyncToEngine} from "./connect-sync"

const PROJECTS = path.resolve(__dirname, "../../public/projects")

// Register a scriptable device's user script into the worklet-global registry (as engine-host.loadScriptDevices
// does in the app), so its bridge finds a Processor.
const registerScripts = (boxGraph: BoxGraph): number => {
    const configs: Record<string, {header: string, registry: string, fn: string}> = {
        ApparatDeviceBox: {header: "apparat", registry: "apparatProcessors", fn: "apparat"},
        WerkstattDeviceBox: {header: "werkstatt", registry: "werkstattProcessors", fn: "werkstatt"},
        SpielwerkDeviceBox: {header: "spielwerk", registry: "spielwerkProcessors", fn: "spielwerk"}
    }
    let count = 0
    for (const box of boxGraph.boxes()) {
        const config = box instanceof ApparatDeviceBox ? configs.ApparatDeviceBox
            : box instanceof WerkstattDeviceBox ? configs.WerkstattDeviceBox
            : box instanceof SpielwerkDeviceBox ? configs.SpielwerkDeviceBox : undefined
        if (config === undefined) {continue}
        const code = (box as unknown as {code: {getValue(): string}}).code.getValue()
        const match = code.match(/^\/\/ @\w+ js \d+ (\d+)\n/)
        if (match === null) {continue}
        new Function(ScriptCompiler.wrap(
            {headerTag: config.header, registryName: config.registry, functionName: config.fn},
            UUID.toString(box.address.uuid), parseInt(match[1]), code.slice(match[0].length)))()
        count++
    }
    return count
}

export type OdRender = {
    output: Float32Array // interleaved planar (L|R per quantum), `quanta * outputLen`
    boxGraph: BoxGraph
    scriptedDevices: number
    audioFiles: number
    samplesLoaded: number
}

// Render `name`.od (from public/projects) for `quanta` render quanta. Loads every AudioFileBox via the engine's
// drain handshake (the test harness supplies a synthetic tone for each — enough to prove the asset path resolves
// and the tape / audio-region players are AUDIBLE; swap in real PCM here for a byte-faithful render).
export const renderOd = async (name: string, quanta = 256): Promise<OdRender> => {
    const buffer = readFileSync(path.join(PROJECTS, `${name}.od`))
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
    const {boxGraph} = ProjectSkeleton.decode(arrayBuffer)
    const audioFiles = boxGraph.boxes().filter(box => box instanceof AudioFileBox).length
    const scriptedDevices = registerScripts(boxGraph)

    const {engine, memory, drainSamples} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, boxGraph)
    await sync.settle(); engine.bind(); await sync.settle()
    const samplesLoaded = drainSamples()
    await sync.settle()
    engine.set_metronome_enabled(0)

    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    const output = new Float32Array(quanta * len)
    for (let q = 0; q < quanta; q++) {
        engine.render()
        output.set(new Float32Array(memory.buffer, engine.output_ptr(), len), q * len)
    }
    return {output, boxGraph, scriptedDevices, audioFiles, samplesLoaded}
}
