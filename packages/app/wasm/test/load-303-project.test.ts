// End-to-end: a REAL serialized project (public/projects/303.od) with scripted devices (Spielwerk + Apparat)
// must produce audio through the WASM engine. This guards the gap the parity tests miss: those seed the script
// registry by hand, but a loaded .od needs its user scripts REGISTERED into the worklet scope (engine-host's
// `loadScriptDevices`, mirrored here with `ScriptCompiler.wrap`) or the bridges find no Processor and stay silent.
import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const OD = path.resolve(__dirname, "../public/projects/303.od")

// Mirror engine-host.loadScriptDevices, but register via `new Function(wrap(...))()` (node has no AudioWorklet).
const SCRIPT_CONFIGS: Record<string, ScriptCompiler.Config> = {
    ApparatDeviceBox: {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
    WerkstattDeviceBox: {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"},
    SpielwerkDeviceBox: {headerTag: "spielwerk", registryName: "spielwerkProcessors", functionName: "spielwerk"}
}

describe("load 303 project", () => {
    it("registers its scripted devices and renders audible output", async () => {
        const arrayBuffer = new Uint8Array(readFileSync(OD)).buffer as ArrayBuffer
        const {boxGraph} = ProjectSkeleton.decode(arrayBuffer)

        let scriptedDevices = 0
        for (const box of boxGraph.boxes()) {
            const config = SCRIPT_CONFIGS[box.name]
            if (config === undefined) {continue}
            const scriptBox = box as ScriptCompiler.ScriptDeviceBox
            const code = scriptBox.code.getValue()
            const match = code.match(/^\/\/ @\w+ js \d+ (\d+)\n/)
            expect(match, `${box.name} has a script header`).not.toBeNull()
            const update = parseInt(match![1])
            const userCode = code.slice(match![0].length)
            const uuid = UUID.toString(box.address.uuid)
            new Function(ScriptCompiler.wrap(config, uuid, update, userCode))()
            scriptedDevices++
        }
        expect(scriptedDevices, "the project contains scripted devices").toBeGreaterThan(0)

        const {engine, memory, drainSamples} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, boxGraph)
        await sync.settle(); engine.bind(); await sync.settle()
        drainSamples()
        engine.set_metronome_enabled(0)

        const len = engine.output_len() >>> 0
        const QUANTA = 256 // ~0.68s at 48k: enough for the sequence to voice notes
        engine.stop(); engine.play()
        let peak = 0
        for (let q = 0; q < QUANTA; q++) {
            engine.render()
            const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
            for (let i = 0; i < len; i++) {peak = Math.max(peak, Math.abs(out[i]))}
        }
        expect(peak, "the scripted project produced audio").toBeGreaterThan(0.01)
    }, 30000)
})
