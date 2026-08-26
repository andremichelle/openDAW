// Root-cause probe for the browser observation: the unit strip's peak meter read -inf after a
// Convolver was inserted mid-session, healing on any later rebuild. This replicates the worklet's
// #syncBroadcasts loop (buffer-identity guard + generation + per-entry views) against the real
// engine and watches the UNIT-strip FLOAT_ARRAY slot across a live insert.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ConvolverDeviceBox, AudioUnitBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {buildEffectProject, peakOf} from "./helpers/effect-harness"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

type Sub = {uuid: string, keys: ReadonlyArray<number>, packageType: number, ptr: number, values: Float32Array}

// The worklet's #syncBroadcasts, verbatim in behavior: re-enumerate when the buffer identity or the
// generation changed, else keep the cached views.
class SyncReplica {
    subs: Array<Sub> = []
    buffer: ArrayBufferLike | null = null
    generation = -1
    resubscribes = 0
    constructor(readonly engine: any, readonly memory: WebAssembly.Memory) {}
    sync(): void {
        const buffer = this.memory.buffer
        if (buffer !== this.buffer) {
            this.buffer = buffer
            this.generation = -1
        }
        const generation = this.engine.broadcast_generation()
        if (generation === this.generation) {return}
        this.generation = generation
        this.resubscribes++
        this.subs.length = 0
        const count = this.engine.broadcast_count()
        for (let index = 0; index < count; index++) {
            const recordPtr = this.engine.input_reserve(48)
            if (this.engine.broadcast_entry(index, recordPtr) === 0) {continue}
            const record = new DataView(this.memory.buffer, recordPtr, 48)
            const uuid = UUID.toString(new Uint8Array(this.memory.buffer.slice(recordPtr, recordPtr + 16)) as UUID.Bytes)
            const packageType = record.getUint32(16, true)
            const pointer = record.getUint32(20, true)
            const length = record.getUint32(24, true)
            const keysCount = record.getUint32(28, true)
            const keys: Array<number> = []
            for (let position = 0; position < keysCount; position++) {keys.push(record.getUint16(32 + position * 2, true))}
            this.subs.push({uuid, keys, packageType, ptr: pointer, values: new Float32Array(this.memory.buffer, pointer, length)})
            this.engine.broadcast_set_active(index, 1) // every address subscribed, like an open mixer
        }
    }
    stripPeak(unitUuid: string): number | null {
        const sub = this.subs.find(entry => entry.uuid === unitUuid && entry.keys.length === 0 && entry.packageType === 1)
        if (sub === undefined) {return null}
        // a detached view (buffer replaced by memory.grow) reads as length 0
        if (sub.values.length === 0) {return NaN}
        let max = 0
        for (const value of sub.values) {max = Math.max(max, Math.abs(value))}
        return max
    }
}

describe("convolver live insert vs strip meter broadcast", () => {
    it("the unit strip meter keeps reporting after a mid-play convolver insert", async () => {
        let unitBox: AudioUnitBox | null = null
        const source: BoxGraph = buildEffectProject(0.3, (_source, unit) => {
            unitBox = unit
            return unit
        })
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        const unitUuid = UUID.toString(unitBox!.address.uuid)
        const replica = new SyncReplica(engine, memory)
        const len = engine.output_len() >>> 0
        engine.stop(); engine.play()
        const insertAt = 24
        const quanta = 160
        const log: Array<string> = []
        let buffers = 0
        let lastBuffer: ArrayBufferLike | null = null
        const meterBefore: Array<number> = []
        const meterAfter: Array<number> = []
        const outputAfter: Array<number> = []
        for (let q = 0; q < quanta; q++) {
            if (q === insertAt) {
                source.beginTransaction()
                ConvolverDeviceBox.create(source, UUID.generate(), box => {
                    box.host.refer(unitBox!.audioEffects)
                    box.index.setValue(0)
                })
                source.endTransaction()
                await sync.settle()
            }
            engine.render()
            if (memory.buffer !== lastBuffer) {lastBuffer = memory.buffer; buffers++}
            replica.sync()
            const meter = replica.stripPeak(unitUuid)
            const out = peakOf(new Float32Array(memory.buffer, engine.output_ptr(), len))
            if (q < insertAt) {meterBefore.push(meter ?? -1)} else {
                meterAfter.push(meter ?? -1)
                outputAfter.push(out)
            }
            if (q === insertAt || q === insertAt + 1 || q === quanta - 1) {
                log.push(`q${q}: meter=${meter} out=${out.toFixed(4)} gen=${replica.generation} subs=${replica.subs.length} resub=${replica.resubscribes} buffers=${buffers}`)
            }
        }
        console.info(log.join("\n"))
        console.info(`meter before insert: max ${Math.max(...meterBefore)}; after: max ${Math.max(...meterAfter)}, ` +
            `last16 max ${Math.max(...meterAfter.slice(-16))}; output after: max ${Math.max(...outputAfter)}`)
        expect(Math.max(...meterBefore)).toBeGreaterThan(0.01) // meter worked before the insert
        expect(Math.max(...outputAfter)).toBeGreaterThan(0.01) // audio flows after the insert
        expect(Math.max(...meterAfter.slice(-16))).toBeGreaterThan(0.01) // and the meter still reports it
    }, 30000)
})
