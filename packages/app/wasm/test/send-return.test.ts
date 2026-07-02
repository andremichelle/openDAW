// SEND / RETURN routing in the Rust engine (both phases):
//   Phase 1 (bus / submix): an instrument routes its OUTPUT into an AudioBusBox; a bus-type AudioUnitBox takes
//     that bus as its input, runs its own strip, and outputs to the master. Muting the bus unit silences the
//     instrument (its only path to the master is through the bus); a -12 dB bus volume attenuates it.
//   Phase 2 (parallel aux send): an instrument outputs dry to the master AND taps a parallel AuxSendBox into a
//     bus. Enabling the send adds signal (wet on top of dry); a lower sendGain adds less.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioBusBox, AudioUnitBox, AuxSendBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SYNTH = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, gain: velocity * 0.4, freq: 440 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const s = Math.sin(voice.phase * Math.PI * 2) * voice.gain
                l[i] += s; r[i] += s
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

// Add an Apparat sine instrument + a held note to `unit`, and register the wrapped script.
const addSineInstrument = (source: BoxGraph, unit: AudioUnitBox): string => {
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + SYNTH)
    })
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
        box.pitch.setValue(69)
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
    return UUID.toString(apparat.address.uuid)
}

const registerApparat = (uuid: string) => new Function(ScriptCompiler.wrap(
    {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, uuid, 1, SYNTH))()

const renderPeak = async (source: BoxGraph, quanta = 48): Promise<number> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    let peak = 0
    for (let q = 0; q < quanta; q++) {
        engine.render()
        const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
        for (let i = 0; i < len; i++) {
            expect(Number.isFinite(out[i])).toBe(true)
            peak = Math.max(peak, Math.abs(out[i]))
        }
    }
    return peak
}

describe("send / return routing", () => {
    it("Phase 1: an instrument routes through a submix bus; muting / attenuating the bus applies", async () => {
        // Baseline: instrument -> master directly.
        const direct = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        const directSource = direct.boxGraph
        directSource.beginTransaction()
        const directUnit = AudioUnitBox.create(directSource, UUID.generate(), box => {
            box.collection.refer(direct.mandatoryBoxes.rootBox.audioUnits)
            box.output.refer(direct.mandatoryBoxes.primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        const directApparat = addSineInstrument(directSource, directUnit)
        directSource.endTransaction()
        registerApparat(directApparat)
        const directPeak = await renderPeak(directSource)
        expect(directPeak).toBeGreaterThan(0.05)

        // Build: instrument -> submix bus -> master. A helper so mute / volume variants share the topology.
        const buildRouted = (busVolumeDb: number, busMute: boolean) => {
            const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
                ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
            source.beginTransaction()
            const instrumentUnit = AudioUnitBox.create(source, UUID.generate(), box => {
                box.collection.refer(rootBox.audioUnits)
                box.index.setValue(1)
            })
            const bus = AudioBusBox.create(source, UUID.generate(), box => {
                box.collection.refer(rootBox.audioBusses)
                box.output.refer(primaryAudioBusBox.input) // the bus feeds the master
                box.label.setValue("Submix")
            })
            const busUnit = AudioUnitBox.create(source, UUID.generate(), box => {
                box.collection.refer(rootBox.audioUnits)
                box.type.setValue("bus")
                box.output.refer(primaryAudioBusBox.input) // the bus UNIT's strip -> master
                box.volume.setValue(busVolumeDb)
                box.mute.setValue(busMute)
                box.index.setValue(2)
            })
            bus.output.refer(busUnit.input)          // the AudioBusBox is the bus unit's input device
            instrumentUnit.output.refer(bus.input)    // the instrument routes INTO the bus (not the master)
            const apparat = addSineInstrument(source, instrumentUnit)
            source.endTransaction()
            registerApparat(apparat)
            return source
        }

        const routedPeak = await renderPeak(buildRouted(0.0, false))
        expect(routedPeak).toBeGreaterThan(0.05)
        expect(Math.abs(routedPeak - directPeak)).toBeLessThan(directPeak * 0.1) // 0 dB submix == direct, within 10%

        const mutedPeak = await renderPeak(buildRouted(0.0, true))
        expect(mutedPeak).toBeLessThan(directPeak / 100) // muting the bus silences the instrument's only path

        const attenuatedPeak = await renderPeak(buildRouted(-12.0, false))
        const expected = directPeak * Math.pow(10, -12 / 20) // -12 dB ~ x0.25
        expect(Math.abs(attenuatedPeak - expected)).toBeLessThan(expected * 0.2)
    }, 60000)

    it("Phase 2: a parallel aux send adds wet signal into a bus, scaled by sendGain", async () => {
        const build = (withSend: boolean, sendGainDb: number) => {
            const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
                ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
            source.beginTransaction()
            const instrumentUnit = AudioUnitBox.create(source, UUID.generate(), box => {
                box.collection.refer(rootBox.audioUnits)
                box.output.refer(primaryAudioBusBox.input) // DRY path: instrument -> master
                box.index.setValue(1)
            })
            const bus = AudioBusBox.create(source, UUID.generate(), box => {
                box.collection.refer(rootBox.audioBusses)
                box.output.refer(primaryAudioBusBox.input)
                box.label.setValue("FX")
            })
            const busUnit = AudioUnitBox.create(source, UUID.generate(), box => {
                box.collection.refer(rootBox.audioUnits)
                box.type.setValue("bus")
                box.output.refer(primaryAudioBusBox.input)
                box.index.setValue(2)
            })
            bus.output.refer(busUnit.input)
            if (withSend) {
                AuxSendBox.create(source, UUID.generate(), box => {
                    box.audioUnit.refer(instrumentUnit.auxSends) // the send belongs to the instrument unit
                    box.targetBus.refer(bus.input)              // and feeds the FX bus
                    box.index.setValue(0)
                    box.sendGain.setValue(sendGainDb)
                    box.sendPan.setValue(0.0)
                })
            }
            const apparat = addSineInstrument(source, instrumentUnit)
            source.endTransaction()
            registerApparat(apparat)
            return source
        }

        const dryPeak = await renderPeak(build(false, 0.0))
        expect(dryPeak).toBeGreaterThan(0.05)
        // The send adds a parallel copy of the SAME signal into the bus -> master: with 0 dB send, the wet copy
        // roughly doubles the summed level (phase-aligned copies of the same sine).
        const wetPeak = await renderPeak(build(true, 0.0))
        expect(wetPeak).toBeGreaterThan(dryPeak * 1.5)
        // A quieter send (-24 dB) adds far less.
        const quietSendPeak = await renderPeak(build(true, -24.0))
        expect(quietSendPeak).toBeLessThan(wetPeak)
        expect(quietSendPeak).toBeGreaterThan(dryPeak * 0.9) // still at least the dry level
    }, 60000)
})
