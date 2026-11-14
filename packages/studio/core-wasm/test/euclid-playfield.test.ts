// Euclid in front of a Playfield: every pad pulls its own replica of the effect, the editor reads one report.
import {describe, expect, it} from "vitest"
import {asInstanceOf, UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioUnitBox, EuclidDeviceBox, GrooveShuffleBox, NanoDeviceBox, PlayfieldDeviceBox} from "@opendaw/studio-boxes"
import {Euclid, PlayfieldPads, ProjectSkeleton} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

// 120 bpm at 48 kHz: a quantum of 128 frames is 5.12 pulses
const QUANTA_PER_SIXTEENTH = 240 / 5.12

describe("Euclid on a Playfield", () => {
    it("plays the stored pattern, switches on the next bar and reports both", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        const playfield = PlayfieldDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
        ;[{note: 60, panning: -1}, {note: 64, panning: 1}].forEach(({note, panning}) => {
            const file = AudioFileBox.create(source, UUID.generate(), box => {
                box.startInSeconds.setValue(0.0)
                box.endInSeconds.setValue(1.0)
                box.fileName.setValue("synthetic")
            })
            const pad = PlayfieldPads.create(source, playfield, file, note)
            pad.pan.setValue(panning)
            pad.instrument.pointerHub.incoming().forEach(({box}) => asInstanceOf(box, NanoDeviceBox).oneShot.setValue(false))
        })
        const device = EuclidDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.pattern.setValue(1)
            box.length.setValue(16)
        })
        const groove = GrooveShuffleBox.create(source, UUID.generate(), box => {
            box.label.setValue("Shuffle")
            box.duration.setValue(480)
            box.amount.setValue(0.6)
        })
        device.patterns.fields()[1].groove.refer(groove)
        ;[60, 64].forEach(note => {
            const lane = Euclid.createLane(source, device, note)
            Euclid.rhythmOf(lane, 1).pulses.setValue(16)
            Euclid.rhythmOf(lane, 2).pulses.setValue(4)
        })
        source.endTransaction()
        const {engine, memory, drainSamples} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        drainSamples()
        await sync.settle()
        engine.set_metronome_enabled(0)
        const half = (engine.output_len() >>> 0) >>> 1
        const report = (): ReadonlyArray<number> => {
            const count = engine.broadcast_count() >>> 0
            for (let index = 0; index < count; index++) {
                const recordPtr = engine.input_reserve(48)
                if (engine.broadcast_entry(index, recordPtr) === 0) {continue}
                const record = new DataView(memory.buffer, recordPtr, 48)
                const uuid = new Uint8Array(memory.buffer, recordPtr, 16).slice() as UUID.Bytes
                if (!UUID.equals(uuid, device.address.uuid) || record.getUint32(28, true) !== 1
                    || record.getUint16(32, true) !== Euclid.StateKey) {continue}
                return Array.from(new Int32Array(memory.buffer, record.getUint32(20, true), 2))
            }
            return []
        }
        engine.stop(); engine.play()
        const levels: Array<number> = []
        const render = (quanta: number) => {
            for (let index = 0; index < quanta; index++) {
                engine.render()
                const block = new Float32Array(memory.buffer, engine.output_ptr(), half)
                levels.push(block.reduce((max, value) => Math.max(max, Math.abs(value)), 0))
            }
        }
        render(Math.floor(2.5 * QUANTA_PER_SIXTEENTH))
        expect(report()).toEqual([1, Euclid.NoPattern])
        source.beginTransaction()
        device.pattern.setValue(2)
        source.endTransaction()
        await sync.settle()
        render(1)
        expect(report()).toEqual([1, 2])
        render(Math.floor(24 * QUANTA_PER_SIXTEENTH) - levels.length)
        expect(report()).toEqual([2, Euclid.NoPattern])
        const at = (step: number) => levels[Math.floor((step + 0.5) * QUANTA_PER_SIXTEENTH)] > 0.01
        expect([5, 6, 7].map(at)).toEqual([true, true, true])
        expect([17, 18, 19, 20].map(at)).toEqual([false, false, false, true])
        sync.close()
    }, 60000)
})
