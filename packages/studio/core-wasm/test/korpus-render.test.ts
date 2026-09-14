// Renders Korpus 2 configs through the REAL wasm engine (device_korpus.wasm loaded like the
// studio does) and asserts audible, finite output — native render tests cannot catch
// engine-path breaks. Field surface: exciter/object A/object B/routing per the frozen table.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBox, KorpusDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {KorpusPresets, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

type Config = {
    name: string
    apply: (box: KorpusDeviceBox) => void
}

const CONFIGS: ReadonlyArray<Config> = [
    {name: "strike marimba (default)", apply: _box => {}},
    {name: "gamelan pair (coupled)", apply: box => {
        box.objectB.setValue(1)
        box.dampingB.setValue(0.75)
        box.detuneB.setValue(7.0)
        box.couple.setValue(0.25)
    }},
    {name: "bar into skin (serial)", apply: box => {
        box.dampingA.setValue(0.3)
        box.objectB.setValue(3)
        box.dampingB.setValue(0.45)
        box.tuneB.setValue(-12)
        box.routing.setValue(1)
        box.levelB.setValue(0.8)
    }},
    {name: "breath bar", apply: box => {
        box.exciter.setValue(1)
        box.intensity.setValue(0.45)
    }},
    {name: "bowed vibraphone", apply: box => {
        box.exciter.setValue(2)
        box.intensity.setValue(0.3)
        box.position.setValue(0.25)
        box.objectA.setValue(1)
        box.dampingA.setValue(0.85)
        box.vibrato.setValue(0.15)
    }},
    {name: "picked wire", apply: box => {
        box.exciter.setValue(3)
        box.intensity.setValue(0.6)
        box.position.setValue(0.12)
        box.objectA.setValue(5)
        box.dampingA.setValue(0.8)
    }},
    {name: "wind pipe", apply: box => {
        box.exciter.setValue(4)
        box.intensity.setValue(0.55)
        box.position.setValue(0.3)
        box.objectA.setValue(0)
        box.dampingA.setValue(0.5)
        box.vibrato.setValue(0.15)
    }},
]

describe("korpus 2 configs through the wasm engine", () => {
    CONFIGS.forEach(({name, apply}) => it(`${name} is audible`, async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        KorpusDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
            apply(box)
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
            box.duration.setValue(3840)
            box.pitch.setValue(57)
            box.velocity.setValue(0.8)
            box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(track.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(7680)
            box.loopDuration.setValue(7680)
        })
        source.endTransaction()

        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)

        const len = engine.output_len() >>> 0
        const half = len / 2
        const QUANTA = 500 // ~1.3s at 48k/128 — slow bow attacks need room to speak
        let peak = 0
        let finite = true
        engine.stop(); engine.play()
        for (let quantum = 0; quantum < QUANTA; quantum++) {
            engine.render()
            const left = new Float32Array(memory.buffer, engine.output_ptr(), half)
            for (let index = 0; index < half; index++) {
                const sample = left[index]
                if (!Number.isFinite(sample)) {finite = false}
                const magnitude = Math.abs(sample)
                if (magnitude > peak) {peak = magnitude}
            }
        }
        expect(finite, `${name}: non-finite output`).toBe(true)
        expect(peak, `${name}: silent through the engine (peak ${peak})`).toBeGreaterThan(1e-3)
        expect(peak, `${name}: blowing up (peak ${peak})`).toBeLessThan(4.0)
    }), 30_000)

    it("switching the exciter live keeps sounding", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        const korpus = KorpusDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
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
            box.duration.setValue(1920)
            box.pitch.setValue(57)
            box.velocity.setValue(0.8)
            box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(track.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(3840)
            box.loopDuration.setValue(3840)
        })
        source.endTransaction()

        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)

        const len = engine.output_len() >>> 0
        const half = len / 2
        const renderPeak = (quanta: number) => {
            let peak = 0
            for (let quantum = 0; quantum < quanta; quantum++) {
                engine.render()
                const left = new Float32Array(memory.buffer, engine.output_ptr(), half)
                for (let index = 0; index < half; index++) {
                    const magnitude = Math.abs(left[index])
                    if (magnitude > peak) {peak = magnitude}
                }
            }
            return peak
        }
        engine.stop(); engine.play()
        const strikePeak = renderPeak(200)
        expect(strikePeak, `strike before the switch (peak ${strikePeak})`).toBeGreaterThan(1e-3)
        source.beginTransaction()
        korpus.exciter.setValue(2)
        korpus.objectA.setValue(1)
        korpus.dampingA.setValue(0.85)
        source.endTransaction()
        await sync.settle()
        engine.stop(); engine.play()
        const bowPeak = renderPeak(500)
        expect(bowPeak, `bow after the live switch (peak ${bowPeak})`).toBeGreaterThan(1e-3)
    }, 30_000)

    it("the damping knob chokes a ringing note live", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        const korpus = KorpusDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
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
            box.duration.setValue(3840)
            box.pitch.setValue(57)
            box.velocity.setValue(0.9)
            box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(track.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(7680)
            box.loopDuration.setValue(7680)
        })
        source.endTransaction()

        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)

        const len = engine.output_len() >>> 0
        const half = len / 2
        const renderRms = (quanta: number): number => {
            let sum = 0
            let count = 0
            for (let quantum = 0; quantum < quanta; quantum++) {
                engine.render()
                const left = new Float32Array(memory.buffer, engine.output_ptr(), half)
                for (let index = 0; index < half; index++) {
                    sum += left[index] * left[index]
                    count++
                }
            }
            return Math.sqrt(sum / count)
        }
        engine.stop(); engine.play()
        const ringing = renderRms(100)
        expect(ringing, `marimba must ring before the choke (rms ${ringing})`).toBeGreaterThan(1e-3)
        // The note is still held — only the knob moves. No stop/play: the voice keeps sounding.
        source.beginTransaction()
        korpus.dampingA.setValue(0.0)
        source.endTransaction()
        await sync.settle()
        renderRms(100) // let the choke settle through the smoothed live path
        const choked = renderRms(100)
        // Natural decay alone sits near 0.11x here — 0.01 only passes if the choke is live.
        expect(choked, `choked ring must collapse live (rms ${choked} vs ${ringing})`)
            .toBeLessThan(ringing * 0.01)
    }, 30_000)

    it("loading a preset silences the sounding patch at once", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        const korpus = KorpusDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
            box.exciter.setValue(4)
            box.intensity.setValue(0.6)
            box.objectA.setValue(0)
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
            box.duration.setValue(3840)
            box.pitch.setValue(57)
            box.velocity.setValue(0.8)
            box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(track.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(7680)
            box.loopDuration.setValue(7680)
        })
        source.endTransaction()

        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)

        const len = engine.output_len() >>> 0
        const half = len / 2
        const renderRms = (quanta: number): number => {
            let sum = 0
            let count = 0
            for (let quantum = 0; quantum < quanta; quantum++) {
                engine.render()
                const left = new Float32Array(memory.buffer, engine.output_ptr(), half)
                for (let index = 0; index < half; index++) {
                    sum += left[index] * left[index]
                    count++
                }
            }
            return Math.sqrt(sum / count)
        }
        engine.stop(); engine.play()
        const blowing = renderRms(150)
        expect(blowing, `wind must sound before the switch (rms ${blowing})`).toBeGreaterThan(1e-3)
        // A plain knob move is live feedback, never a cut.
        source.beginTransaction()
        korpus.intensity.setValue(0.5)
        source.endTransaction()
        await sync.settle()
        const tweaked = renderRms(40)
        expect(tweaked, `a knob move must keep sounding (rms ${tweaked} vs ${blowing})`)
            .toBeGreaterThan(blowing * 0.3)
        // The note is still held and the transport never stops — only the preset loads.
        source.beginTransaction()
        KorpusPresets.apply(korpus, KorpusPresets.Factory[0])
        source.endTransaction()
        await sync.settle()
        renderRms(8) // ~20ms: the ~1.5ms declick decays to nothing in here
        const after = renderRms(40)
        expect(after, `the old patch must be silent after a preset load (rms ${after} vs ${blowing})`)
            .toBeLessThan(blowing * 0.001)
    }, 30_000)
})
