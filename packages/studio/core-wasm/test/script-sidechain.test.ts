// Named sidechains for the scriptable devices (#211): each `// @sidechain <name>` is a WerkstattSidechainBox under
// the device's `side-chains` hub, the engine turns every child into a sidechain port, and the script bridge hands
// the resolved buffers to the user Processor as `this.sidechains[name]`. Sources here are Werkstatt generators
// on MUTED units (a sidechain taps the device output, before the strip), so the master carries only the device
// under test.
import {readFileSync} from "node:fs"
import {describe, expect, it} from "vitest"
import {asInstanceOf, UUID} from "@opendaw/lib-std"
import {
    ApparatDeviceBox,
    AudioUnitBox,
    RootBox,
    VaporisateurDeviceBox,
    WerkstattDeviceBox,
    WerkstattParameterBox,
    WerkstattSidechainBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, ScriptDeclaration} from "@opendaw/studio-adapters"
import {BoxGraph} from "@opendaw/lib-box"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine, EngineSync} from "./helpers/connect-sync"

const WERKSTATT = {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}
const APPARAT = {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}
const MIXER = readFileSync(new URL("./assets/werkstatt/sidechain-mixer.js", import.meta.url), "utf8")

// Deterministic sources: A is a ramp on the left (checks per-sample alignment), B a constant pair.
const SOURCE_A = (index: number): [number, number] => [index / 1000, 0.2]
const SOURCE_B = (index: number): [number, number] => [0.3, -0.6 + index / 2000]
const generator = (left: string, right: string) => `class Processor {
    process({out}, {s0, s1}) {
        const [l, r] = out
        for (let i = s0; i < s1; i++) { l[i] = ${left}; r[i] = ${right} }
    }
}`
const GENERATOR_A = generator("i / 1000", "0.2")
const GENERATOR_B = generator("0.3", "-0.6 + i / 2000")
// Sidechain A at full gain, the other declared name at half gain, so a wrong name -> source mapping is visible.
const TWO_NAMED = (first: string, second: string) => `// @sidechain ${first}
// @sidechain ${second}
class Processor {
    process({out}, {s0, s1}) {
        const [l, r] = out
        const [aL, aR] = this.sidechains.A
        const [bL, bR] = this.sidechains.${first === "A" ? second : first}
        for (let i = s0; i < s1; i++) { l[i] = aL[i] + 0.5 * bL[i]; r[i] = aR[i] + 0.5 * bR[i] }
    }
}`

type Rig<T> = {
    source: BoxGraph
    sync: EngineSync
    render: (quanta?: number) => {left: Float32Array, right: Float32Array}
    generatorB: WerkstattDeviceBox
    messages: ReadonlyArray<string>
    value: T
}

const createSourceUnit = (source: BoxGraph, rootBox: RootBox, index: number, code: string): WerkstattDeviceBox => {
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.index.setValue(index)
        box.mute.setValue(true)
    })
    VaporisateurDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
    const generatorBox = WerkstattDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.code.setValue("// @werkstatt js 1 1\n" + code)
    })
    new Function(ScriptCompiler.wrap(WERKSTATT, UUID.toString(generatorBox.address.uuid), 1, code))()
    return generatorBox
}

const createSidechain = (source: BoxGraph, owner: WerkstattDeviceBox | ApparatDeviceBox, label: string, index: number,
                         target?: WerkstattDeviceBox): WerkstattSidechainBox =>
    WerkstattSidechainBox.create(source, UUID.generate(), box => {
        box.owner.refer(owner.sideChains)
        box.label.setValue(label)
        box.index.setValue(index)
        if (target !== undefined) {box.source.refer(target)}
    })

const createRig = async <T>(populate: (source: BoxGraph, routedUnit: AudioUnitBox,
                                        generators: {a: WerkstattDeviceBox, b: WerkstattDeviceBox}) => T): Promise<Rig<T>> => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const generatorA = createSourceUnit(source, rootBox, 1, GENERATOR_A)
    const generatorB = createSourceUnit(source, rootBox, 2, GENERATOR_B)
    const routedUnit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(3)
    })
    const value = populate(source, routedUnit, {a: generatorA, b: generatorB})
    source.endTransaction()
    const messages: Array<string> = []
    const {engine, memory} = await loadFullEngine(48000, (_uuid, message) => messages.push(message))
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    const len = engine.output_len() >>> 0
    const half = len / 2
    const render = (quanta: number = 4) => {
        for (let quantum = 0; quantum < quanta; quantum++) {engine.render()}
        const output = new Float32Array(memory.buffer, engine.output_ptr(), len).slice()
        return {left: output.subarray(0, half), right: output.subarray(half, len)}
    }
    return {source, sync, render, generatorB, messages, value}
}

const createWerkstatt = (source: BoxGraph, unit: AudioUnitBox, code: string): WerkstattDeviceBox => {
    VaporisateurDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
    const werkstatt = WerkstattDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.code.setValue("// @werkstatt js 1 1\n" + code)
    })
    new Function(ScriptCompiler.wrap(WERKSTATT, UUID.toString(werkstatt.address.uuid), 1, code))()
    return werkstatt
}

const recompile = (source: BoxGraph, device: WerkstattDeviceBox, update: number, code: string): void => {
    new Function(ScriptCompiler.wrap(WERKSTATT, UUID.toString(device.address.uuid), update, code))()
    source.beginTransaction()
    device.code.setValue(`// @werkstatt js 1 ${update}\n` + code)
    ScriptCompiler.reconcileSidechainBoxes(device.sideChains, ScriptDeclaration.parseSidechains(code))
    source.endTransaction()
}

const expectMix = (output: {left: Float32Array, right: Float32Array}, gainA: number, gainB: number): void => {
    for (let index = 0; index < output.left.length; index++) {
        const [aL, aR] = SOURCE_A(index)
        const [bL, bR] = SOURCE_B(index)
        expect(output.left[index]).toBeCloseTo(aL * gainA + bL * gainB, 5)
        expect(output.right[index]).toBeCloseTo(aR * gainA + bR * gainB, 5)
    }
}

const labelsOf = (device: WerkstattDeviceBox): ReadonlyArray<string> => device.sideChains.pointerHub.incoming()
    .map(pointer => asInstanceOf(pointer.box, WerkstattSidechainBox))
    .sort((a, b) => a.index.getValue() - b.index.getValue())
    .map(box => box.label.getValue())

describe("script sidechains", () => {
    it("the Sidechain Mixer example mixes every named sidechain with its gain", async () => {
        const {render} = await createRig((source, unit, {a, b}) => {
            const mixer = createWerkstatt(source, unit, MIXER)
            const order = ScriptDeclaration.parseDeclarationOrder(MIXER)
            const values: Record<string, number> = {input: 1, gainA: 0.75, gainB: 0.5}
            for (const declaration of ScriptDeclaration.parseParams(MIXER)) {
                WerkstattParameterBox.create(source, UUID.generate(), box => {
                    box.owner.refer(mixer.parameters)
                    box.label.setValue(declaration.label)
                    box.index.setValue(order.get(declaration.label) ?? 0)
                    box.value.setValue(values[declaration.label])
                    box.defaultValue.setValue(declaration.defaultValue)
                })
            }
            createSidechain(source, mixer, "A", 0, a)
            createSidechain(source, mixer, "B", 1, b)
        })
        expectMix(render(), 0.75, 0.5)
    }, 30000)

    it("an unconnected sidechain reads silence and clearing one source removes only that source", async () => {
        const {source, sync, render, value: sideB} = await createRig((source, unit, {a, b}) => {
            const device = createWerkstatt(source, unit, TWO_NAMED("A", "B"))
            createSidechain(source, device, "A", 0, a)
            return createSidechain(source, device, "B", 1, b)
        })
        expectMix(render(), 1, 0.5)
        source.beginTransaction()
        sideB.source.defer()
        source.endTransaction()
        await sync.settle()
        expectMix(render(), 1, 0)
    }, 30000)

    it("reordering the @sidechain lines keeps every name on its source", async () => {
        const {source, sync, render, value: device} = await createRig((source, unit, {a, b}) => {
            const device = createWerkstatt(source, unit, TWO_NAMED("A", "B"))
            createSidechain(source, device, "A", 0, a)
            createSidechain(source, device, "B", 1, b)
            return device
        })
        expectMix(render(), 1, 0.5)
        recompile(source, device, 2, TWO_NAMED("B", "A"))
        await sync.settle()
        expect(labelsOf(device)).toEqual(["B", "A"])
        expectMix(render(), 1, 0.5)
    }, 30000)

    it("renaming one sidechain drops only its source, the other keeps its own", async () => {
        const {source, sync, render, value: device} = await createRig((source, unit, {a, b}) => {
            const device = createWerkstatt(source, unit, TWO_NAMED("A", "B"))
            createSidechain(source, device, "A", 0, a)
            createSidechain(source, device, "B", 1, b)
            return device
        })
        recompile(source, device, 2, TWO_NAMED("A", "C"))
        await sync.settle()
        expect(labelsOf(device)).toEqual(["A", "C"])
        expectMix(render(), 1, 0) // B is now C, unconnected: silence
    }, 30000)

    it("a sidechain added and connected at runtime joins the mix", async () => {
        const {source, sync, render, generatorB, value: device} = await createRig((source, unit, {a}) => {
            const device = createWerkstatt(source, unit, TWO_NAMED("A", "B"))
            createSidechain(source, device, "A", 0, a)
            return device
        })
        expectMix(render(), 1, 0)
        source.beginTransaction()
        const added = createSidechain(source, device, "B", 1)
        source.endTransaction()
        await sync.settle()
        expectMix(render(), 1, 0)
        source.beginTransaction()
        added.source.refer(generatorB)
        source.endTransaction()
        await sync.settle()
        expectMix(render(), 1, 0.5)
        source.beginTransaction()
        added.delete()
        source.endTransaction()
        await sync.settle()
        expectMix(render(), 1, 0)
    }, 30000)

    it("a script without @sidechain keeps its own this.sidechains", async () => {
        const OWN = `class Processor {
    sidechains = {own: 7}
    process({out}, {s0, s1}) {
        const [l, r] = out
        const value = this.sidechains.own === 7 ? 0.125 : 0
        for (let i = s0; i < s1; i++) { l[i] = value; r[i] = value }
    }
}`
        const {render} = await createRig((source, unit) => {createWerkstatt(source, unit, OWN)})
        const {left, right} = render()
        expect(left.every(sample => sample === 0.125)).toBe(true)
        expect(right.every(sample => sample === 0.125)).toBe(true)
    }, 30000)

    it("Apparat reads its named sidechain", async () => {
        const CODE = `// @sidechain In
class Processor {
    process(output, {s0, s1}) {
        const [l, r] = output
        const [inL, inR] = this.sidechains.In
        for (let i = s0; i < s1; i++) { l[i] = inL[i]; r[i] = inR[i] }
    }
}`
        const {render} = await createRig((source, unit, {a}) => {
            const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
                box.host.refer(unit.input)
                box.code.setValue("// @apparat js 1 1\n" + CODE)
            })
            new Function(ScriptCompiler.wrap(APPARAT, UUID.toString(apparat.address.uuid), 1, CODE))()
            createSidechain(source, apparat, "In", 0, a)
        })
        expectMix(render(), 1, 0)
    }, 30000)

    describe("unhappy paths", () => {
        const READS = (name: string) => `class Processor {
    process({out}, {s0, s1}) {
        const [l, r] = this.sidechains.${name}
        for (let i = s0; i < s1; i++) { out[0][i] = l[i]; out[1][i] = r[i] }
    }
}`
        const expectSilence = ({left, right}: {left: Float32Array, right: Float32Array}): void => {
            expect(left.every(sample => sample === 0)).toBe(true)
            expect(right.every(sample => sample === 0)).toBe(true)
        }

        it("reading a name that is no longer declared silences the device with a named error", async () => {
            const {render, messages} = await createRig((source, unit, {a}) => {
                const device = createWerkstatt(source, unit, "// @sidechain New\n" + READS("Old"))
                createSidechain(source, device, "New", 0, a)
            })
            expectSilence(render())
            expect(messages).toEqual(["Runtime error: Error: No @sidechain 'Old' declared (declared: New)"])
        }, 30000)

        it("reading this.sidechains without any declaration explains the missing @sidechain", async () => {
            const {render, messages} = await createRig((source, unit) => {createWerkstatt(source, unit, READS("Key"))})
            expectSilence(render())
            expect(messages).toEqual(["Runtime error: TypeError: Cannot read properties of undefined (reading 'Key')" +
                " (this.sidechains is only available with a // @sidechain <name> declaration)"])
        }, 30000)

        it("an unrelated TypeError in a script without sidechains gets no sidechain hint", async () => {
            const CODE = `class Processor { process() { null.value } }`
            const {render, messages} = await createRig((source, unit) => {createWerkstatt(source, unit, CODE)})
            render()
            expect(messages.length).toBe(1)
            expect(messages[0]).not.toContain("@sidechain")
        }, 30000)

        it("a malformed declaration fails to compile with a clear message", () => {
            expect(() => ScriptCompiler.wrap(WERKSTATT, UUID.toString(UUID.generate()), 1, "// @sidechain A B\n" + READS("A")))
                .toThrow("Malformed @sidechain: '// @sidechain A B' — expected: // @sidechain <name>")
        })

        it("a duplicate declaration resolves to one sidechain", async () => {
            const CODE = "// @sidechain A\n// @sidechain A\n" + READS("A")
            expect(ScriptDeclaration.parseSidechains(CODE)).toEqual([{label: "A"}])
            const {render, messages} = await createRig((source, unit, {a}) => {
                const device = createWerkstatt(source, unit, CODE)
                createSidechain(source, device, "A", 0, a)
            })
            expectMix(render(), 1, 0)
            expect(messages).toEqual([])
        }, 30000)
    })
})
