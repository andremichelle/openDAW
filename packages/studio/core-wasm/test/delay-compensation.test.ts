// Plugin delay compensation (#482): every path meets at its junction at the same time. Each case plays one
// single-sample impulse per instrument at the same position; a Compressor with look-ahead (240 frames at 48 kHz)
// sits on one path. Uncompensated the master shows two impulses 240 frames apart, compensated a single one.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {
    ApparatDeviceBox,
    AudioBusBox,
    AudioEffectCompositeBox,
    AudioEffectCompositeCellBox,
    AudioUnitBox,
    AuxSendBox,
    CompressorDeviceBox,
    DelayDeviceBox,
    ReverbDeviceBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox,
    WerkstattDeviceBox
} from "@opendaw/studio-boxes"
import type {BoxGraph, Field} from "@opendaw/lib-box"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {Pointers} from "@opendaw/studio-enums"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {leftChannel} from "./helpers/effect-harness"
import {readSignalGraph, settleCompensation} from "../src/engine-exports"

const IMPULSE = `class Processor {
    pending = false
    noteOn() { this.pending = true }
    noteOff() {}
    process(output, block) {
        if (this.pending) { output[0][block.s0] += 0.5; output[1][block.s0] += 0.5; this.pending = false }
    }
}`

type Skeleton = ReturnType<typeof ProjectSkeleton.empty>

const impulseUnit = (skeleton: Skeleton, index: number, scripts: Array<string>): AudioUnitBox => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(index)
    })
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + IMPULSE)
    })
    scripts.push(UUID.toString(apparat.address.uuid))
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events)
        box.position.setValue(0)
        box.duration.setValue(100_000)
        box.pitch.setValue(60)
        box.velocity.setValue(1.0)
        box.cent.setValue(0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(100_000)
        box.loopDuration.setValue(100_000)
    })
    return unit
}

const neutralCompressor = (source: BoxGraph, host: Field<Pointers.AudioEffectHost>, lookahead: boolean): CompressorDeviceBox =>
    CompressorDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(host)
        box.index.setValue(0)
        box.lookahead.setValue(lookahead)
        box.threshold.setValue(0.0)
        box.ratio.setValue(1.0)
        box.knee.setValue(0.0)
        box.inputgain.setValue(0.0)
        box.makeup.setValue(0.0)
        box.automakeup.setValue(false)
        box.mix.setValue(1.0)
    })

const busUnit = (skeleton: Skeleton, index: number): { bus: AudioBusBox, unit: AudioUnitBox } => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
    const bus = AudioBusBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioBusses)
        box.output.refer(primaryAudioBusBox.input)
        box.label.setValue("Bus")
    })
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.type.setValue("bus")
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(index)
    })
    bus.output.refer(unit.input)
    return {bus, unit}
}

const build = (populate: (skeleton: Skeleton, scripts: Array<string>) => void) => {
    const skeleton = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const scripts: Array<string> = []
    skeleton.boxGraph.beginTransaction()
    populate(skeleton, scripts)
    skeleton.boxGraph.endTransaction()
    scripts.forEach(uuid => new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, uuid, 1, IMPULSE))())
    return skeleton.boxGraph
}

const start = async (source: BoxGraph) => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    const play = (quanta: number) => {
        engine.stop(); engine.play()
        const out = new Float32Array(quanta * len)
        for (let quantum = 0; quantum < quanta; quantum++) {
            engine.render()
            out.set(new Float32Array(memory.buffer, engine.output_ptr(), len), quantum * len)
        }
        return leftChannel(out)
    }
    const idle = (quanta: number) => {for (let quantum = 0; quantum < quanta; quantum++) {engine.render()}}
    idle(8)
    return {engine, memory, sync, play, idle}
}

const peaks = (signal: Float32Array): Array<[number, number]> => Array.from(signal)
    .map((value, index): [number, number] => [index, Number(value.toFixed(3))])
    .filter(([, value]) => Math.abs(value) > 0.01)

describe("plugin delay compensation", () => {
    it("aligns two tracks at the master when one has look-ahead", async () => {
        const source = build((skeleton, scripts) => {
            impulseUnit(skeleton, 1, scripts)
            const latent = impulseUnit(skeleton, 2, scripts)
            neutralCompressor(skeleton.boxGraph, latent.audioEffects, true)
        })
        const {engine, memory, play} = await start(source)
        expect(peaks(play(8))).toEqual([[240, 1]])
        const graph = readSignalGraph(engine, memory)
        const master = graph.nodes.find(node => node.label === "master-sum")
        expect(master?.arrival).toBe(240)
        expect(graph.edges.filter(edge => edge.target === master?.id).map(edge => edge.delay).sort()).toEqual([0, 240])
    }, 30000)

    it("aligns a dry track with a track routed through a bus that has look-ahead", async () => {
        const source = build((skeleton, scripts) => {
            impulseUnit(skeleton, 1, scripts)
            const routed = impulseUnit(skeleton, 2, scripts)
            const {bus, unit} = busUnit(skeleton, 3)
            routed.output.refer(bus.input)
            neutralCompressor(skeleton.boxGraph, unit.audioEffects, true)
        })
        const {play} = await start(source)
        expect(peaks(play(8))).toEqual([[240, 1]])
    }, 30000)

    it("aligns a dry path with its aux send into a return that has look-ahead", async () => {
        const source = build((skeleton, scripts) => {
            const unit = impulseUnit(skeleton, 1, scripts)
            const {bus, unit: returnUnit} = busUnit(skeleton, 2)
            AuxSendBox.create(skeleton.boxGraph, UUID.generate(), box => {
                box.audioUnit.refer(unit.auxSends)
                box.targetBus.refer(bus.input)
                box.index.setValue(0)
                box.sendGain.setValue(0.0)
                box.sendPan.setValue(0.0)
            })
            neutralCompressor(skeleton.boxGraph, returnUnit.audioEffects, true)
        })
        const {play} = await start(source)
        expect(peaks(play(8))).toEqual([[240, 1]])
    }, 30000)

    it("aligns the dry path of an effects stack with a latent entry", async () => {
        const source = build((skeleton, scripts) => {
            const unit = impulseUnit(skeleton, 1, scripts)
            const composite = AudioEffectCompositeBox.create(skeleton.boxGraph, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.index.setValue(0)
                box.dry.setValue(0.0)
                box.wet.setValue(0.0)
            })
            const entry = AudioEffectCompositeCellBox.create(skeleton.boxGraph, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(0)
            })
            neutralCompressor(skeleton.boxGraph, entry.audioEffects, true)
        })
        const {play} = await start(source)
        const result = peaks(play(8))
        expect(result.length).toBe(1)
        expect(result[0][0]).toBe(240)
    }, 30000)

    it("re-aligns when look-ahead is switched off at runtime", async () => {
        const holder: { compressor?: CompressorDeviceBox } = {}
        const source = build((skeleton, scripts) => {
            impulseUnit(skeleton, 1, scripts)
            const latent = impulseUnit(skeleton, 2, scripts)
            holder.compressor = neutralCompressor(skeleton.boxGraph, latent.audioEffects, true)
        })
        const {sync, play, idle} = await start(source)
        expect(peaks(play(8))).toEqual([[240, 1]])
        source.beginTransaction(); holder.compressor!.lookahead.setValue(false); source.endTransaction()
        await sync.settle()
        idle(16)
        expect(peaks(play(8))).toEqual([[0, 1]])
    }, 30000)

    it("delays the main input of a compressor whose sidechain arrives late", async () => {
        const holder: { ducker?: CompressorDeviceBox } = {}
        const source = build((skeleton, scripts) => {
            const kick = impulseUnit(skeleton, 1, scripts)
            neutralCompressor(skeleton.boxGraph, kick.audioEffects, true)
            const bass = impulseUnit(skeleton, 2, scripts)
            holder.ducker = neutralCompressor(skeleton.boxGraph, bass.audioEffects, false)
            holder.ducker.sideChain.refer(kick)
        })
        const {engine, memory, play} = await start(source)
        expect(peaks(play(8))).toEqual([[240, 1]])
        const graph = readSignalGraph(engine, memory)
        const ducker = graph.nodes.find(node => node.owner !== null && UUID.equals(node.owner, holder.ducker!.address.uuid))
        expect(ducker?.arrival).toBe(240)
        const inputs = graph.edges.filter(edge => edge.target === ducker?.id)
        expect(inputs.find(edge => edge.data)?.delay).toBe(240)
        expect(inputs.find(edge => !edge.data)?.delay).toBe(0)
    }, 30000)

    it("aligns every stem to the master so each stem lines up after the latency trim", async () => {
        const units: Array<AudioUnitBox> = []
        const source = build((skeleton, scripts) => {
            units.push(impulseUnit(skeleton, 1, scripts))
            const latent = impulseUnit(skeleton, 2, scripts)
            neutralCompressor(skeleton.boxGraph, latent.audioEffects, true)
            units.push(latent)
        })
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle()
        const pointer = engine.input_reserve(40)
        units.forEach((unit, index) => {
            new Uint8Array(memory.buffer, pointer + index * 20, 16).set(unit.address.uuid)
            new DataView(memory.buffer, pointer + index * 20, 20).setUint32(16, 1, true)
        })
        engine.set_stem_export(2, 0)
        engine.bind()
        await sync.settle()
        engine.set_metronome_enabled(0)
        for (let quantum = 0; quantum < 8; quantum++) {engine.render()}
        engine.stop(); engine.play()
        const stems = [new Float32Array(8 * 128), new Float32Array(8 * 128)]
        for (let quantum = 0; quantum < 8; quantum++) {
            engine.render()
            const staging = new Float32Array(memory.buffer, engine.stem_output_ptr(), 4 * 128)
            stems[0].set(staging.subarray(0, 128), quantum * 128)
            stems[1].set(staging.subarray(256, 384), quantum * 128)
        }
        expect(engine.compensation_latency()).toBe(240)
        expect(peaks(stems[0])).toEqual([[240, 0.5]])
        expect(peaks(stems[1])).toEqual([[240, 0.5]])
    }, 30000)

    it("compensates the latency a Werkstatt script declares", async () => {
        const delayScript = `class Processor {
    constructor() { this.latency = 100; this.ring = [new Float32Array(100), new Float32Array(100)]; this.cursor = 0 }
    process({src, out}, {s0, s1}) {
        for (let i = s0; i < s1; i++) {
            for (let channel = 0; channel < 2; channel++) {
                out[channel][i] = this.ring[channel][this.cursor]
                this.ring[channel][this.cursor] = src[channel][i]
            }
            this.cursor = (this.cursor + 1) % 100
        }
    }
}`
        const werkstatts: Array<string> = []
        const source = build((skeleton, scripts) => {
            impulseUnit(skeleton, 1, scripts)
            const latent = impulseUnit(skeleton, 2, scripts)
            const werkstatt = WerkstattDeviceBox.create(skeleton.boxGraph, UUID.generate(), box => {
                box.host.refer(latent.audioEffects)
                box.index.setValue(0)
                box.code.setValue("// @werkstatt js 1 1\n" + delayScript)
            })
            werkstatts.push(UUID.toString(werkstatt.address.uuid))
        })
        werkstatts.forEach(uuid => new Function(ScriptCompiler.wrap(
            {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}, uuid, 1, delayScript))())
        const {engine, idle, play} = await start(source)
        idle(8)
        expect(engine.compensation_latency()).toBe(100)
        expect(peaks(play(8))).toEqual([[100, 1]])
    }, 30000)

    it("settles before an offline render so the trimmed output starts aligned on frame 0", async () => {
        const delayScript = `class Processor {
    constructor() { this.latency = 100; this.ring = [new Float32Array(100), new Float32Array(100)]; this.cursor = 0 }
    process({src, out}, {s0, s1}) {
        for (let i = s0; i < s1; i++) {
            for (let channel = 0; channel < 2; channel++) {
                out[channel][i] = this.ring[channel][this.cursor]
                this.ring[channel][this.cursor] = src[channel][i]
            }
            this.cursor = (this.cursor + 1) % 100
        }
    }
}`
        const werkstatts: Array<string> = []
        const source = build((skeleton, scripts) => {
            impulseUnit(skeleton, 1, scripts)
            const latent = impulseUnit(skeleton, 2, scripts)
            neutralCompressor(skeleton.boxGraph, latent.audioEffects, true)
            const werkstatt = WerkstattDeviceBox.create(skeleton.boxGraph, UUID.generate(), box => {
                box.host.refer(latent.audioEffects)
                box.index.setValue(1)
                box.code.setValue("// @werkstatt js 1 1\n" + delayScript)
            })
            werkstatts.push(UUID.toString(werkstatt.address.uuid))
        })
        werkstatts.forEach(uuid => new Function(ScriptCompiler.wrap(
            {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}, uuid, 1, delayScript))())
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        engine.set_position(0); engine.play()
        const trim = settleCompensation(engine, 48000, 0, true, () => engine.render())
        expect(trim).toBe(340)
        const len = engine.output_len() >>> 0
        const out = new Float32Array(8 * len)
        for (let quantum = 0; quantum < 8; quantum++) {
            engine.render()
            out.set(new Float32Array(memory.buffer, engine.output_ptr(), len), quantum * len)
        }
        expect(peaks(leftChannel(out).subarray(trim))).toEqual([[0, 1]])
    }, 30000)

    it("settling leaves a project without latency bit-identical", async () => {
        const project = () => build((skeleton, scripts) => {
            const unit = impulseUnit(skeleton, 1, scripts)
            DelayDeviceBox.create(skeleton.boxGraph, UUID.generate(), box => {box.host.refer(unit.audioEffects); box.index.setValue(1)})
            ReverbDeviceBox.create(skeleton.boxGraph, UUID.generate(), box => {box.host.refer(unit.audioEffects); box.index.setValue(2)})
        })
        const render = async (settled: boolean) => {
            const {engine, memory} = await loadFullEngine()
            const sync = connectSyncToEngine(engine, memory, project())
            await sync.settle(); engine.bind(); await sync.settle()
            engine.set_metronome_enabled(0)
            engine.set_position(0); engine.play()
            if (settled) {expect(settleCompensation(engine, 48000, 0, true, () => engine.render())).toBe(0)}
            const len = engine.output_len() >>> 0
            const out = new Float32Array(64 * len)
            for (let quantum = 0; quantum < 64; quantum++) {
                engine.render()
                out.set(new Float32Array(memory.buffer, engine.output_ptr(), len), quantum * len)
            }
            return out
        }
        const plain = await render(false)
        const settled = await render(true)
        expect(plain.some(sample => sample !== 0)).toBe(true)
        expect(settled).toEqual(plain)
    }, 30000)

    it("leaves a project without latency untouched", async () => {
        const source = build((skeleton, scripts) => {
            impulseUnit(skeleton, 1, scripts)
            const other = impulseUnit(skeleton, 2, scripts)
            neutralCompressor(skeleton.boxGraph, other.audioEffects, false)
        })
        const {engine, memory, play} = await start(source)
        expect(peaks(play(8))).toEqual([[0, 1]])
        expect(readSignalGraph(engine, memory).edges.every(edge => edge.delay === 0)).toBe(true)
    }, 30000)
})
