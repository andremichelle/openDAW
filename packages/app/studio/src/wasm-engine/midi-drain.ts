// Feeds the wasm engine's queued MIDI-out records into the studio's UNCHANGED MIDISender SAB ring (the
// lock-free transport the TS engine uses: all MIDI data travels through the SharedArrayBuffer, the port
// only posts a `null` wake-up signal). The hot path is allocation-free per event: the 1/2/3-byte payload
// buffers are preallocated and reused, device-id strings are fetched once per device number and cached.
// Shared by the realtime worklet processor and the offline render worker.
import {int, isDefined, Nullable} from "@opendaw/lib-std"
import {MIDISender} from "../../../../studio/core-processors/src/MIDISender"
import {EngineExports} from "../../../wasm/src/engine-exports"
import {decodeUtf8} from "../../../wasm/src/utf8"

const RECORD_BYTES = 16 // WASM CONTRACT: [device u32 LE][status u8][data1 u8][data2 u8][length u8][timeMs f64 LE]

export class WasmMidiDrain {
    readonly #deviceIds = new Map<int, string>()
    readonly #scratch: ReadonlyArray<Uint8Array> = [new Uint8Array(1), new Uint8Array(2), new Uint8Array(3)]

    #sender: Nullable<MIDISender> = null

    connect(port: MessagePort, sab: SharedArrayBuffer): void {
        this.#sender = new MIDISender(port, sab)
    }

    drain(engine: EngineExports, memory: WebAssembly.Memory): void {
        const count = engine.midi_out_count()
        if (count === 0) {return}
        const pointer = engine.input_reserve(count * RECORD_BYTES)
        const taken = engine.midi_out_take(pointer)
        const sender = this.#sender
        if (sender === null) {return} // drained + dropped: no MIDI channel attached (keeps the engine queue bounded)
        // Copy the batch out of the input scratch: a device-id fetch below reuses that scratch, and talc may
        // grow (detach) the memory. One small copy per EVENTFUL quantum — nothing allocates per event.
        const records = new Uint8Array(memory.buffer, pointer, taken * RECORD_BYTES).slice()
        const view = new DataView(records.buffer)
        for (let index = 0; index < taken; index++) {
            const offset = index * RECORD_BYTES
            const device = view.getUint32(offset, true)
            const length = Math.min(Math.max(view.getUint8(offset + 7), 1), 3)
            const timeMs = view.getFloat64(offset + 8, true)
            const data = this.#scratch[length - 1]
            data[0] = view.getUint8(offset + 4)
            if (length > 1) {data[1] = view.getUint8(offset + 5)}
            if (length > 2) {data[2] = view.getUint8(offset + 6)}
            sender.send(this.#deviceId(engine, memory, device), data, timeMs)
        }
    }

    #deviceId(engine: EngineExports, memory: WebAssembly.Memory, num: int): string {
        const cached = this.#deviceIds.get(num)
        if (isDefined(cached)) {return cached}
        const pointer = engine.input_reserve(256)
        const length = engine.midi_out_device_id(num, pointer, 256)
        // Decoded WITHOUT TextDecoder (the AudioWorkletGlobalScope has none), once per device number.
        const id = length === 0 ? "" : decodeUtf8(new Uint8Array(memory.buffer, pointer, length))
        this.#deviceIds.set(num, id)
        return id
    }
}
