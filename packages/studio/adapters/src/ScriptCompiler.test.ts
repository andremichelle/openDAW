import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {BoxEditing} from "@opendaw/lib-box"
import {AudioUnitBox, VaporisateurDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "./project/ProjectSkeleton"
import {ScriptCompiler} from "./ScriptCompiler"

const CONFIG: ScriptCompiler.Config = {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}
const CODE_A = "class Processor { process() {} }"
const CODE_B = "class Processor { process() { } }"

// Counts the scripts registered in the worklet scope; `fail` makes the next addModule reject.
const createContext = () => {
    const modules: Array<string> = []
    const state = {fail: false}
    const audioWorklet = {
        addModule: async (url: string): Promise<void> => {
            if (state.fail) {
                state.fail = false
                throw new Error("addModule failed")
            }
            modules.push(url)
        }
    }
    return {context: {audioWorklet} as unknown as BaseAudioContext, modules, state}
}

const createDevice = (code: string = "") => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const editing = new BoxEditing(boxGraph)
    const device = editing.modify(() => {
        const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
        })
        VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
        return WerkstattDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.code.setValue(code)
        })
    }).unwrap("device")
    return {editing, device}
}

describe("ScriptCompiler registers each script version once per audio context", () => {
    it("loading the same version again registers nothing", async () => {
        const {context, modules} = createContext()
        const {device} = createDevice(`// @werkstatt js 1 3\n${CODE_A}`)
        await ScriptCompiler.create(CONFIG).load(context, device)
        await ScriptCompiler.create(CONFIG).load(context, device)
        await ScriptCompiler.create(CONFIG).load(context, device)
        expect(modules.length).toBe(1)
    })

    it("concurrent loads of the same version register once", async () => {
        const {context, modules} = createContext()
        const {device} = createDevice(`// @werkstatt js 1 3\n${CODE_A}`)
        await Promise.all([
            ScriptCompiler.create(CONFIG).load(context, device),
            ScriptCompiler.create(CONFIG).load(context, device)
        ])
        expect(modules.length).toBe(1)
    })

    it("a compile registers once, even when another editor reloads on the code change", async () => {
        const {context, modules} = createContext()
        const {editing, device} = createDevice(`// @werkstatt js 1 1\n${CODE_A}`)
        const liveEditor = ScriptCompiler.create(CONFIG)
        await liveEditor.load(context, device)
        const reloads: Array<Promise<void>> = []
        const subscription = device.code.subscribe(() => reloads.push(liveEditor.load(context, device)))
        await ScriptCompiler.create(CONFIG).compile(context, editing, device, CODE_B)
        await Promise.all(reloads)
        subscription.terminate()
        expect(reloads.length).toBe(1)
        expect(modules.length).toBe(2)
    })

    it("a different version (undo, recompile) registers again", async () => {
        const {context, modules} = createContext()
        const {editing, device} = createDevice(`// @werkstatt js 1 1\n${CODE_A}`)
        const compiler = ScriptCompiler.create(CONFIG)
        await compiler.load(context, device)
        await compiler.compile(context, editing, device, CODE_B)
        expect(modules.length).toBe(2)
        editing.undo()
        await compiler.load(context, device)
        expect(modules.length).toBe(3)
    })

    it("another audio context registers its own copy", async () => {
        const first = createContext()
        const second = createContext()
        const {device} = createDevice(`// @werkstatt js 1 2\n${CODE_A}`)
        await ScriptCompiler.create(CONFIG).load(first.context, device)
        await ScriptCompiler.create(CONFIG).load(second.context, device)
        expect(first.modules.length).toBe(1)
        expect(second.modules.length).toBe(1)
    })

    it("a failed registration is retried by the next load", async () => {
        const {context, modules, state} = createContext()
        const {device} = createDevice(`// @werkstatt js 1 2\n${CODE_A}`)
        state.fail = true
        await expect(ScriptCompiler.create(CONFIG).load(context, device)).rejects.toThrow("addModule failed")
        await ScriptCompiler.create(CONFIG).load(context, device)
        expect(modules.length).toBe(1)
    })
})
