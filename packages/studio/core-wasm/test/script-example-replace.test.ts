// Loading an example replaces the scriptable device with a fresh one (ScriptCompiler.replace): nothing of the old
// device (its Processor, parameter values, records, automation) may reach the new script, also not while the new
// Processor is still registering. The worklet registration is faked so the test holds that gap open on purpose.
import {readdirSync, readFileSync} from "node:fs"
import {resolveObjectURL} from "node:buffer"
import {describe, expect, it} from "vitest"
import {asInstanceOf, Option, UUID} from "@opendaw/lib-std"
import {BoxEditing, BoxGraph} from "@opendaw/lib-box"
import {
    ApparatDeviceBox,
    AudioUnitBox,
    LfoModulatorBox,
    ModulationBox,
    SpielwerkDeviceBox,
    TrackBox,
    VaporisateurDeviceBox,
    WerkstattDeviceBox,
    WerkstattParameterBox,
    WerkstattSidechainBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, ScriptDeclaration, ScriptRecords, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const WERKSTATT = {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}
const APPARAT = {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}
const SPIELWERK = {headerTag: "spielwerk", registryName: "spielwerkProcessors", functionName: "spielwerk"}
const example = (path: string): string =>
    readFileSync(new URL(`../../../app/studio/src/ui/devices/${path}`, import.meta.url), "utf8")
const fixture = (name: string): string => readFileSync(new URL(`./assets/apparat/${name}`, import.meta.url), "utf8")
const XY_FILTER = example("audio-effects/examples/xy-filter.js")
const CHAOS_PAD = example("audio-effects/examples/chaos-pad.js")
const PARAMETRIC_EQ = example("audio-effects/examples/parametric-eq.js")
const SINE = `class Processor {
    phase = 0
    process({out}, {s0, s1}) {
        const [l, r] = out
        for (let i = s0; i < s1; i++) { l[i] = r[i] = Math.sin(this.phase) * 0.5; this.phase += 0.0575 }
    }
}`
const THROUGH = `class Processor {
    process({src, out}, {s0, s1}) {
        for (let i = s0; i < s1; i++) { out[0][i] = src[0][i]; out[1][i] = src[1][i] }
    }
}`
// every paramChanged lands in globalThis.probeLog tagged with the script, so the test sees who received what
const probe = (tag: string, params: string): string => `${params}
class Processor {
    paramChanged(label, value) { (globalThis.probeLog ??= []).push(["${tag}", label, value]) }
    process({src, out}, {s0, s1}) {
        for (let i = s0; i < s1; i++) { out[0][i] = src[0][i]; out[1][i] = src[1][i] }
    }
}`
const PROBE_A = probe("A", "// @param alpha 0.25\n// @param beta 3 0 10 int\n// @param delta 0.1")
const PROBE_B = probe("B", "// @param gamma 0.5\n// @param alpha 0.75 0 1 linear\n// @param beta true")
const PROBE_B_DEFAULTS: Record<string, number> = {gamma: 0.5, alpha: 0.75, beta: 1}

type ProbeEntry = [string, string, number]
type ProbeGlobal = { probeLog?: Array<ProbeEntry> }
const probeLog = (): Array<ProbeEntry> => {
    const scope = globalThis as unknown as ProbeGlobal
    scope.probeLog ??= []
    return scope.probeLog
}

// addModule evaluates the module like the worklet scope, `hold()` keeps registrations pending until `release()`
class FakeWorklet {
    readonly #pending: Array<() => void> = []
    #held = false
    readonly context = {
        audioWorklet: {
            addModule: async (url: string): Promise<void> => {
                const blob = resolveObjectURL(url)
                if (blob === undefined) {throw new Error(`unknown module ${url}`)}
                const text = await blob.text()
                if (this.#held) {await new Promise<void>(resolve => this.#pending.push(resolve))}
                new Function(text)()
            }
        }
    } as unknown as BaseAudioContext
    hold(): void {this.#held = true}
    release(): void {
        this.#held = false
        this.#pending.splice(0).forEach(resolve => resolve())
    }
}

const renewWerkstatt = (box: ScriptCompiler.ScriptDeviceBox, uuid: UUID.Bytes): ScriptCompiler.ScriptDeviceBox => {
    const device = asInstanceOf(box, WerkstattDeviceBox)
    return WerkstattDeviceBox.create(device.graph, uuid, fresh => {
        fresh.host.refer(device.host.targetVertex.unwrap("werkstatt host"))
        fresh.index.setValue(device.index.getValue())
        fresh.label.setValue("Werkstatt")
    })
}

const createRig = async () => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const editing = new BoxEditing(boxGraph)
    const worklet = new FakeWorklet()
    const compilers = {
        werkstatt: ScriptCompiler.create(WERKSTATT),
        apparat: ScriptCompiler.create(APPARAT),
        spielwerk: ScriptCompiler.create(SPIELWERK)
    }
    const unit = editing.modify(() => {
        const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
        return unit
    }).unwrap()
    const messages: Array<string> = []
    const {engine, memory} = await loadFullEngine(48000, (_uuid, message) => messages.push(message))
    const sync = connectSyncToEngine(engine, memory, boxGraph)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    const length = engine.output_len() >>> 0
    const render = (quanta: number): Float32Array => {
        const collected = new Float32Array(quanta * length)
        for (let quantum = 0; quantum < quanta; quantum++) {
            engine.render()
            collected.set(new Float32Array(memory.buffer, engine.output_ptr(), length), quantum * length)
        }
        return collected
    }
    // a device created and compiled like the device editor does it for a fresh device
    const addWerkstatt = async (index: number, code: string): Promise<WerkstattDeviceBox> => {
        const box = editing.modify(() => WerkstattDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(index)
            box.label.setValue("Werkstatt")
        })).unwrap()
        await compilers.werkstatt.compile(worklet.context, editing, box, code, true)
        await sync.settle()
        return box
    }
    const replaceWerkstatt = (box: WerkstattDeviceBox, code: string): Promise<ScriptCompiler.ScriptDeviceBox> => {
        const uuid = UUID.generate()
        return compilers.werkstatt.replace(worklet.context, editing, box, code, () => renewWerkstatt(box, uuid))
    }
    return {boxGraph, editing, worklet, compilers, unit, rootBox, primaryAudioBusBox, sync, render, messages, addWerkstatt, replaceWerkstatt}
}

const paramValues = (box: ScriptCompiler.ScriptDeviceBox): Record<string, number> => Object.fromEntries(
    box.parameters.pointerHub.incoming()
        .map(pointer => asInstanceOf(pointer.box, WerkstattParameterBox))
        .map(param => [param.label.getValue(), param.value.getValue()]))

const paramBox = (box: ScriptCompiler.ScriptDeviceBox, label: string): WerkstattParameterBox => box.parameters.pointerHub.incoming()
    .map(pointer => asInstanceOf(pointer.box, WerkstattParameterBox))
    .find(param => param.label.getValue() === label)!

const defaultsOf = (code: string): Record<string, number> =>
    Object.fromEntries(ScriptDeclaration.parseParams(code).map(({label, defaultValue}) => [label, Math.fround(defaultValue)]))

const peak = (samples: Float32Array): number => samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
const allFinite = (samples: Float32Array): boolean => samples.every(value => Number.isFinite(value))
const exists = (graph: BoxGraph, uuid: UUID.Bytes): boolean => graph.findBox(uuid).nonEmpty()

describe("loading an example replaces the scriptable device", () => {
    it("control: compiling in place hands the new values to the old Processor while the new one registers", async () => {
        const rig = await createRig()
        await rig.addWerkstatt(0, SINE)
        const device = await rig.addWerkstatt(1, XY_FILTER)
        rig.render(8)
        rig.worklet.hold()
        const compiling = rig.compilers.werkstatt.compile(rig.worklet.context, rig.editing, device, CHAOS_PAD)
        await rig.sync.settle()
        rig.render(64)
        expect(rig.messages).toContain("NaN detected in output channel 0 at sample 16")
        rig.worklet.release()
        await compiling
    }, 60000)

    it("XY Filter -> Chaos Pad: no NaN, no old values, also while the new Processor registers", async () => {
        const rig = await createRig()
        await rig.addWerkstatt(0, SINE)
        const device = await rig.addWerkstatt(1, XY_FILTER)
        rig.editing.modify(() => paramBox(device, "cutoff").value.setValue(4000))
        await rig.sync.settle()
        expect(allFinite(rig.render(8))).toBe(true)
        expect(rig.messages).toEqual([])
        rig.worklet.hold()
        const replacing = rig.replaceWerkstatt(device, CHAOS_PAD)
        await rig.sync.settle()
        const gap = rig.render(64)
        expect(allFinite(gap)).toBe(true)
        expect(rig.messages).toEqual([])
        rig.worklet.release()
        const fresh = await replacing
        await rig.sync.settle()
        const after = rig.render(64)
        expect(allFinite(after)).toBe(true)
        expect(peak(after)).toBeGreaterThan(0.1)
        expect(rig.messages).toEqual([])
        expect(exists(rig.boxGraph, device.address.uuid)).toBe(false)
        expect(UUID.equals(fresh.address.uuid, device.address.uuid)).toBe(false)
        expect(paramValues(fresh)).toEqual(defaultsOf(CHAOS_PAD))
        expect(fresh.label.getValue()).toBe("Chaos Pad")
    }, 60000)

    it("the new script only ever receives its own parameters at their defaults", async () => {
        const rig = await createRig()
        await rig.addWerkstatt(0, SINE)
        const device = await rig.addWerkstatt(1, PROBE_A)
        rig.editing.modify(() => {
            paramBox(device, "alpha").value.setValue(0.9)
            paramBox(device, "beta").value.setValue(7)
        })
        await rig.sync.settle()
        rig.render(4)
        expect(probeLog().filter(([tag]) => tag === "A").some(([, label, value]) => label === "alpha" && value === Math.fround(0.9))).toBe(true)
        const before = probeLog().length
        rig.worklet.hold()
        const replacing = rig.replaceWerkstatt(device, PROBE_B)
        await rig.sync.settle()
        rig.render(32)
        rig.worklet.release()
        await replacing
        await rig.sync.settle()
        rig.render(32)
        const received = probeLog().slice(before)
        expect(received.filter(([tag]) => tag === "A")).toEqual([])
        const fromB = received.filter(([tag]) => tag === "B")
        expect(fromB.length).toBeGreaterThan(0)
        for (const [, label, value] of fromB) {
            expect(Object.keys(PROBE_B_DEFAULTS)).toContain(label)
            expect(value).toBeCloseTo(PROBE_B_DEFAULTS[label], 6)
        }
        expect(new Set(fromB.map(([, label]) => label))).toEqual(new Set(Object.keys(PROBE_B_DEFAULTS)))
        expect(rig.messages).toEqual([])
    }, 60000)

    it("the same example again starts from its defaults", async () => {
        const rig = await createRig()
        await rig.addWerkstatt(0, SINE)
        const device = await rig.addWerkstatt(1, CHAOS_PAD)
        rig.editing.modify(() => {
            paramBox(device, "x").value.setValue(0.9)
            paramBox(device, "program").value.setValue(3)
            paramBox(device, "touch").value.setValue(1)
        })
        await rig.sync.settle()
        rig.render(8)
        const fresh = await rig.replaceWerkstatt(device, CHAOS_PAD)
        await rig.sync.settle()
        expect(allFinite(rig.render(32))).toBe(true)
        expect(paramValues(fresh)).toEqual(defaultsOf(CHAOS_PAD))
        expect(rig.messages).toEqual([])
    }, 60000)

    it("records start from the example's seeds", async () => {
        const rig = await createRig()
        await rig.addWerkstatt(0, SINE)
        const device = await rig.addWerkstatt(1, PARAMETRIC_EQ)
        const [bands] = ScriptDeclaration.parseCollections(PARAMETRIC_EQ)
        const seeded = ScriptRecords.read(device.records, bands)
        rig.editing.modify(() => ScriptRecords.set(device.records, bands, 2, {frequency: 7000, gain: 12}))
        expect(ScriptRecords.read(device.records, bands)).not.toEqual(seeded)
        const fresh = await rig.replaceWerkstatt(device, PARAMETRIC_EQ)
        await rig.sync.settle()
        expect(ScriptRecords.read(asInstanceOf(fresh, WerkstattDeviceBox).records, bands)).toEqual(seeded)
        expect(allFinite(rig.render(32))).toBe(true)
        expect(rig.messages).toEqual([])
    }, 60000)

    it("keeps the chain position, drops automation and leaves other devices' sidechains unconnected", async () => {
        const rig = await createRig()
        const head = await rig.addWerkstatt(0, SINE)
        const device = await rig.addWerkstatt(1, XY_FILTER)
        const tail = await rig.addWerkstatt(2, "// @sidechain Key\n" + THROUGH)
        const {track, sidechain} = rig.editing.modify(() => {
            const track = TrackBox.create(rig.boxGraph, UUID.generate(), box => {
                box.tracks.refer(rig.unit.tracks)
                box.target.refer(paramBox(device, "cutoff").value)
                box.type.setValue(TrackType.Value)
                box.index.setValue(0)
            })
            const sidechain = tail.sideChains.pointerHub.incoming().map(pointer => asInstanceOf(pointer.box, WerkstattSidechainBox))[0]
            sidechain.source.refer(device)
            return {track, sidechain}
        }).unwrap()
        await rig.sync.settle()
        rig.render(4)
        const fresh = await rig.replaceWerkstatt(device, CHAOS_PAD)
        await rig.sync.settle()
        const chain = rig.unit.audioEffects.pointerHub.incoming()
            .map(pointer => asInstanceOf(pointer.box, WerkstattDeviceBox))
            .sort((a, b) => a.index.getValue() - b.index.getValue())
        expect(chain.map(box => UUID.toString(box.address.uuid)))
            .toEqual([head, fresh, tail].map(box => UUID.toString(box.address.uuid)))
        expect(chain.map(box => box.index.getValue())).toEqual([0, 1, 2])
        expect(exists(rig.boxGraph, track.address.uuid)).toBe(false)
        expect(exists(rig.boxGraph, sidechain.address.uuid)).toBe(true)
        expect(sidechain.source.targetVertex.isEmpty()).toBe(true)
        expect(allFinite(rig.render(32))).toBe(true)
        expect(rig.messages).toEqual([])
    }, 60000)

    it("is ONE undo step: undo brings the old device back with its values, redo the fresh one", async () => {
        const rig = await createRig()
        await rig.addWerkstatt(0, SINE)
        const device = await rig.addWerkstatt(1, PROBE_A)
        rig.editing.modify(() => paramBox(device, "alpha").value.setValue(0.9))
        rig.editing.mark()
        await rig.sync.settle()
        rig.render(4)
        const checksumBefore = rig.boxGraph.checksum().slice()
        const fresh = await rig.replaceWerkstatt(device, CHAOS_PAD)
        await rig.sync.settle()
        rig.render(8)
        expect(rig.editing.undo()).toBe(true)
        await rig.sync.settle()
        expect(rig.boxGraph.checksum()).toEqual(checksumBefore)
        expect(exists(rig.boxGraph, device.address.uuid)).toBe(true)
        expect(exists(rig.boxGraph, fresh.address.uuid)).toBe(false)
        const restored = asInstanceOf(rig.boxGraph.findBox(device.address.uuid).unwrap(), WerkstattDeviceBox)
        expect(paramValues(restored).alpha).toBeCloseTo(0.9, 6)
        const before = probeLog().length
        expect(allFinite(rig.render(16))).toBe(true)
        expect(probeLog().slice(before).some(([tag, label, value]) => tag === "A" && label === "alpha" && Math.abs(value - 0.9) < 1e-6)).toBe(true)
        expect(rig.editing.redo()).toBe(true)
        await rig.sync.settle()
        expect(exists(rig.boxGraph, device.address.uuid)).toBe(false)
        const redone = asInstanceOf(rig.boxGraph.findBox(fresh.address.uuid).unwrap(), WerkstattDeviceBox)
        expect(paramValues(redone)).toEqual(defaultsOf(CHAOS_PAD))
        expect(allFinite(rig.render(16))).toBe(true)
        expect(rig.messages).toEqual([])
    }, 60000)

    it("a script that does not compile leaves the device untouched", async () => {
        const rig = await createRig()
        const device = await rig.addWerkstatt(0, XY_FILTER)
        rig.editing.mark()
        const checksum = rig.boxGraph.checksum().slice()
        const canUndo = rig.editing.canUndo()
        await expect(rig.replaceWerkstatt(device, "class Processor { process( {")).rejects.toThrow()
        await expect(rig.replaceWerkstatt(device, "// @param x 5 0 1 linear\nclass Processor {}")).rejects.toThrow()
        expect(rig.boxGraph.checksum()).toEqual(checksum)
        expect(exists(rig.boxGraph, device.address.uuid)).toBe(true)
        expect(rig.editing.canUndo()).toBe(canUndo)
    }, 60000)

    it("Apparat keeps its audio unit, Spielwerk its position", async () => {
        const rig = await createRig()
        const {boxGraph, editing, compilers, worklet} = rig
        const {apparatUnit, apparat, spielwerk} = editing.modify(() => {
            const apparatUnit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
                box.collection.refer(rig.rootBox.audioUnits)
                box.output.refer(rig.primaryAudioBusBox.input)
                box.index.setValue(2)
            })
            const apparat = ApparatDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.host.refer(apparatUnit.input)
                box.label.setValue("Apparat")
            })
            const spielwerk = SpielwerkDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.host.refer(apparatUnit.midiEffects)
                box.index.setValue(0)
                box.label.setValue("Spielwerk")
            })
            return {apparatUnit, apparat, spielwerk}
        }).unwrap()
        const instrumentCode = fixture("simple-sine.js")
        const midiCode = example("midi-effects/examples/velocity.js")
        await compilers.apparat.compile(worklet.context, editing, apparat, instrumentCode, true)
        await compilers.spielwerk.compile(worklet.context, editing, spielwerk, midiCode, true)
        await rig.sync.settle()
        rig.render(4)
        const freshApparat = await compilers.apparat.replace(worklet.context, editing, apparat,
            fixture("harmonic-synth.js"), () => {
                const uuid = UUID.generate()
                return ApparatDeviceBox.create(boxGraph, uuid, fresh => {
                    fresh.host.refer(apparat.host.targetVertex.unwrap("apparat host"))
                    fresh.label.setValue("Apparat")
                })
            })
        const freshSpielwerk = await compilers.spielwerk.replace(worklet.context, editing, spielwerk,
            example("midi-effects/examples/step-arp.js"), () => SpielwerkDeviceBox.create(boxGraph, UUID.generate(), fresh => {
                fresh.host.refer(spielwerk.host.targetVertex.unwrap("spielwerk host"))
                fresh.index.setValue(spielwerk.index.getValue())
                fresh.label.setValue("Spielwerk")
            }))
        await rig.sync.settle()
        expect(exists(boxGraph, apparatUnit.address.uuid)).toBe(true)
        expect(apparatUnit.input.pointerHub.incoming().map(pointer => UUID.toString(pointer.box.address.uuid)))
            .toEqual([UUID.toString(freshApparat.address.uuid)])
        expect(apparatUnit.midiEffects.pointerHub.incoming().map(pointer => UUID.toString(pointer.box.address.uuid)))
            .toEqual([UUID.toString(freshSpielwerk.address.uuid)])
        expect(asInstanceOf(freshSpielwerk, SpielwerkDeviceBox).index.getValue()).toBe(0)
        expect(paramValues(freshApparat)).toEqual(defaultsOf(fixture("harmonic-synth.js")))
        expect(allFinite(rig.render(32))).toBe(true)
        expect(rig.messages).toEqual([])
    }, 60000)

    it("a second example while the first still registers replaces the unregistered device cleanly", async () => {
        const rig = await createRig()
        await rig.addWerkstatt(0, SINE)
        const device = await rig.addWerkstatt(1, XY_FILTER)
        rig.worklet.hold()
        const first = rig.replaceWerkstatt(device, CHAOS_PAD)
        await rig.sync.settle()
        rig.render(16)
        const pending = asInstanceOf(rig.unit.audioEffects.pointerHub.incoming()
            .map(pointer => pointer.box).find(box => !UUID.equals(box.address.uuid, device.address.uuid)
                && asInstanceOf(box, WerkstattDeviceBox).index.getValue() === 1)!, WerkstattDeviceBox)
        const second = rig.replaceWerkstatt(pending, PARAMETRIC_EQ)
        await rig.sync.settle()
        rig.render(16)
        rig.worklet.release()
        await first
        const fresh = await second
        await rig.sync.settle()
        const after = rig.render(64)
        expect(allFinite(after)).toBe(true)
        expect(peak(after)).toBeGreaterThan(0.1)
        expect(exists(rig.boxGraph, pending.address.uuid)).toBe(false)
        expect(fresh.label.getValue()).toBe("Parametric EQ")
        expect(rig.unit.audioEffects.pointerHub.incoming().length).toBe(2)
        expect(rig.messages).toEqual([])
    }, 60000)

    it("every shipped example replaces every other one without an error, through a held registration", async () => {
        const rig = await createRig()
        const {boxGraph, editing, compilers, worklet} = rig
        const folder = (path: string): ReadonlyArray<string> => readdirSync(new URL(`../../../app/studio/src/ui/devices/${path}`, import.meta.url))
            .filter(name => name.endsWith(".js")).sort().map(name => `${path}/${name}`)
        await rig.addWerkstatt(0, SINE)
        const sweep = async (first: ScriptCompiler.ScriptDeviceBox, compiler: ReturnType<typeof ScriptCompiler.create>,
                             paths: ReadonlyArray<string>, renew: (box: ScriptCompiler.ScriptDeviceBox) => ScriptCompiler.ScriptDeviceBox,
                             read: (path: string) => string = example) => {
            let current = first
            for (const path of [...paths, ...[...paths].reverse()]) {
                worklet.hold()
                const replacing = compiler.replace(worklet.context, editing, current, read(path), () => renew(current))
                await rig.sync.settle()
                const gap = rig.render(8)
                worklet.release()
                current = await replacing
                await rig.sync.settle()
                const after = rig.render(16)
                expect(allFinite(gap), path).toBe(true)
                expect(allFinite(after), path).toBe(true)
                expect(paramValues(current), path).toEqual(defaultsOf(read(path)))
                expect(rig.messages, path).toEqual([])
            }
        }
        const werkstatt = await rig.addWerkstatt(1, SINE)
        await sweep(werkstatt, compilers.werkstatt, folder("audio-effects/examples"), box => renewWerkstatt(box, UUID.generate()))
        const {apparat, spielwerk} = editing.modify(() => {
            const apparatUnit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
                box.collection.refer(rig.rootBox.audioUnits)
                box.output.refer(rig.primaryAudioBusBox.input)
                box.index.setValue(2)
            })
            const apparat = ApparatDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.host.refer(apparatUnit.input)
                box.label.setValue("Apparat")
            })
            const spielwerk = SpielwerkDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.host.refer(apparatUnit.midiEffects)
                box.index.setValue(0)
                box.label.setValue("Spielwerk")
            })
            return {apparat, spielwerk}
        }).unwrap()
        await compilers.apparat.compile(worklet.context, editing, apparat, fixture("simple-sine.js"), true)
        await compilers.spielwerk.compile(worklet.context, editing, spielwerk, example("midi-effects/examples/velocity.js"), true)
        await rig.sync.settle()
        await sweep(apparat, compilers.apparat, ["harmonic-synth.js", "simple-sine.js"], box => {
            const device = asInstanceOf(box, ApparatDeviceBox)
            return ApparatDeviceBox.create(boxGraph, UUID.generate(), fresh => {
                fresh.host.refer(device.host.targetVertex.unwrap("apparat host"))
                fresh.label.setValue("Apparat")
            })
        }, fixture)
        await sweep(spielwerk, compilers.spielwerk, folder("midi-effects/examples"), box => {
            const device = asInstanceOf(box, SpielwerkDeviceBox)
            return SpielwerkDeviceBox.create(boxGraph, UUID.generate(), fresh => {
                fresh.host.refer(device.host.targetVertex.unwrap("spielwerk host"))
                fresh.index.setValue(device.index.getValue())
                fresh.label.setValue("Spielwerk")
            })
        })
    }, 120000)

    it("Chaos Pad: Hold engages the effect without a touch, so an LFO on X is audible", async () => {
        const rig = await createRig()
        await rig.addWerkstatt(0, SINE)
        const pad = await rig.addWerkstatt(1, CHAOS_PAD)
        const rms = (samples: Float32Array): number => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
        const settle = async (values: Record<string, number>): Promise<number> => {
            rig.editing.modify(() => Object.entries(values).forEach(([label, value]) => paramBox(pad, label).value.setValue(value)))
            await rig.sync.settle()
            rig.render(64)
            return rms(rig.render(800))
        }
        const dry = await settle({})
        expect(dry).toBeGreaterThan(0.3)
        expect(await settle({x: 0.02})).toBeCloseTo(dry, 3)
        expect(await settle({hold: 1})).toBeLessThan(dry * 0.3)
        expect(await settle({hold: 0})).toBeCloseTo(dry, 3)
        rig.editing.modify(() => {
            const lfo = LfoModulatorBox.create(rig.boxGraph, UUID.generate(), box => {
                box.collection.refer(rig.rootBox.modulators)
                box.label.setValue("Wobble")
                box.shape.setValue(4)
                box.rateSync.setValue(4)
            })
            ModulationBox.create(rig.boxGraph, UUID.generate(), box => {
                box.source.refer(lfo.assignments)
                box.target.refer(paramBox(pad, "x").value)
                box.depth.setValue(1.0)
            })
        })
        expect(await settle({x: 0.5})).toBeCloseTo(dry, 3)
        expect(await settle({hold: 1})).toBeLessThan(dry * 0.5)
        expect(rig.messages).toEqual([])
    }, 60000)

    it("only the replaced device changes: the other devices keep their boxes and values", async () => {
        const rig = await createRig()
        const head = await rig.addWerkstatt(0, PROBE_A)
        const device = await rig.addWerkstatt(1, XY_FILTER)
        rig.editing.modify(() => paramBox(head, "alpha").value.setValue(0.6))
        await rig.sync.settle()
        const fresh = await rig.replaceWerkstatt(device, CHAOS_PAD)
        await rig.sync.settle()
        expect(exists(rig.boxGraph, head.address.uuid)).toBe(true)
        expect(paramValues(head).alpha).toBeCloseTo(0.6, 6)
        expect(Option.wrap(fresh).nonEmpty()).toBe(true)
        expect(rig.messages).toEqual([])
    }, 60000)
})
