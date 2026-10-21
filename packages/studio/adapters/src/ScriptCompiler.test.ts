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

describe("ScriptCompiler applies the top-level rule to scripts with a view", () => {
    const VIEW_CODE = "// @view 1 1 4 3\nconst SCALES = [[0, 2], [0, 3]]\nclass Processor {\n    process() { return typeof globalThis }\n}\nclass View {}"
    const evaluateRegistry = (wrapped: string, uuid: string) => {
        new Function(wrapped)()
        const registry = (globalThis as unknown as Record<string, Record<string, Record<string, { create: new () => { process(): string } }>>>)
            .openDAW.werkstattProcessors
        return registry[uuid]
    }

    it("leaves scripts without a view byte-identical", () => {
        const wrapped = ScriptCompiler.wrap(CONFIG, "uuid", 1, CODE_A)
        expect(wrapped).toContain(`create: (function werkstatt() {\n            ${CODE_A}\n            return Processor\n        })(),`)
        expect(wrapped).not.toContain("use strict")
    })

    it("refuses to compile a view script with top-level state", async () => {
        const {context, modules} = createContext()
        const {editing, device} = createDevice()
        const compile = ScriptCompiler.create(CONFIG).compile(context, editing, device, `// @view 1 1 4 3\nlet current = 0\n${CODE_A}`)
        await expect(compile).rejects.toThrow("Line 2: Top-level 'let current' would exist separately")
        expect(modules.length).toBe(0)
        expect(device.code.getValue()).toBe("")
    })

    it("still loads a stored view script that breaks the rule", async () => {
        const {context, modules} = createContext()
        const {device} = createDevice(`// @werkstatt js 1 3\n// @view 1 1 4 3\nlet current = 0\n${CODE_A}`)
        await ScriptCompiler.create(CONFIG).load(context, device)
        expect(modules.length).toBe(1)
    })

    it("wraps a view script strict, with shadowed globals and frozen top-level values", () => {
        const shadowed = evaluateRegistry(ScriptCompiler.wrap(CONFIG, "view-uuid", 1, VIEW_CODE), "view-uuid")
        expect(new shadowed.create().process()).toBe("undefined")
        const probe = VIEW_CODE.replace("return typeof globalThis",
            "return Object.isFrozen(SCALES) && Object.isFrozen(SCALES[0]) ? \"frozen\" : \"open\"")
        const frozen = evaluateRegistry(ScriptCompiler.wrap(CONFIG, "frozen-uuid", 1, probe), "frozen-uuid")
        expect(new frozen.create().process()).toBe("frozen")
    })
})

describe("ScriptCompiler tolerates malformed data directives on load", () => {
    const MALFORMED = "// @stream\n// @buffer wave\n// @collection 1steps\nclass Processor { process() {} }"
    it("loads a stored script whose comments look like broken data directives", () => {
        const wrapped = ScriptCompiler.wrap(CONFIG, "malformed-uuid", 1, MALFORMED)
        new Function(wrapped)()
        const registry = (globalThis as unknown as Record<string, Record<string, Record<string, Record<string, unknown>>>>)
            .openDAW.werkstattProcessors["malformed-uuid"]
        expect(registry.collections).toEqual([])
        expect(registry.streams).toEqual([])
        expect(registry.buffers).toEqual([])
    })
    it("still refuses to compile them", () => {
        expect(() => ScriptCompiler.wrap(CONFIG, "malformed-uuid", 2, MALFORMED, true)).toThrow()
    })
})

describe("ScriptCompiler.wrapView", () => {
    it("hands the declared view and window classes to the runtime", () => {
        const code = "// @view PatternView 1 1 4 3\n// @window EditorView 900 520\n// @view 5 1 2 3\nclass Processor {}\nclass PatternView {}\nclass View {}"
        const received: Array<Record<string, unknown>> = []
        new Function("__openDAWViews", ScriptCompiler.wrapView(code))((registry: Record<string, unknown>) => received.push(registry))
        expect(received).toHaveLength(1)
        expect(Object.keys(received[0])).toEqual(["PatternView", "View", "EditorView"])
        expect(typeof received[0].PatternView).toBe("function")
        expect(received[0].EditorView).toBeUndefined()
    })
    it("freezes the top level in the view realm too", () => {
        const code = "// @view 1 1 2 3\nconst SCALES = [1, 2]\nclass View { push() { SCALES.push(3) } }"
        const received: Array<Record<string, new () => { push(): void }>> = []
        new Function("__openDAWViews", ScriptCompiler.wrapView(code))((registry: Record<string, new () => { push(): void }>) => received.push(registry))
        expect(() => new received[0].View().push()).toThrow(TypeError)
    })
})
