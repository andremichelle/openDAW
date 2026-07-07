// TEMPORARY DIAGNOSTIC (PeakMeter non-finite hunt): play 80s.od the way the STUDIO session does — clips
// LAUNCHED, live transport — and scan EVERY value the UI meters consume each quantum: the main output and
// every float broadcast slot (strip meters, device meters, param unit values). The freeze-stem diagnostic
// left the clip-driven units silent, so their devices never ran; this drives them hot.
import * as path from "node:path"
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {WavFile} from "@opendaw/lib-dsp"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {ApparatDeviceBox, NoteClipBox, SpielwerkDeviceBox, TimelineBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const QUANTUM = 128
const CACHE = "/tmp/opendaw-test-samples"

const decode = (): BoxGraph => {
    const buffer = readFileSync(path.resolve(__dirname, "../../../../test-files/80s.od"))
    return ProjectSkeleton.decode(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer).boxGraph
}

const registerScripts = (boxGraph: BoxGraph): void => {
    for (const box of boxGraph.boxes()) {
        const config = box instanceof ApparatDeviceBox ? {header: "apparat", registry: "apparatProcessors", fn: "apparat"}
            : box instanceof WerkstattDeviceBox ? {header: "werkstatt", registry: "werkstattProcessors", fn: "werkstatt"}
            : box instanceof SpielwerkDeviceBox ? {header: "spielwerk", registry: "spielwerkProcessors", fn: "spielwerk"} : undefined
        if (config === undefined) {continue}
        const code = (box as unknown as {code: {getValue(): string}}).code.getValue()
        const match = code.match(/^\/\/ @\w+ js \d+ (\d+)\n/)
        if (match === null) {continue}
        new Function(ScriptCompiler.wrap(
            {headerTag: config.header, registryName: config.registry, functionName: config.fn},
            UUID.toString(box.address.uuid), parseInt(match[1]), code.slice(match[0].length)))()
    }
}

const fetchSamples = async (boxGraph: BoxGraph): Promise<Array<{uuid: UUID.Bytes, wav: ArrayBuffer}>> => {
    mkdirSync(CACHE, {recursive: true})
    const samples: Array<{uuid: UUID.Bytes, wav: ArrayBuffer}> = []
    for (const box of boxGraph.boxes()) {
        if (box.name !== "AudioFileBox") {continue}
        const uuid = box.address.uuid
        const id = UUID.toString(uuid)
        const file = `${CACHE}/${id}.wav`
        if (!existsSync(file)) {
            const response = await fetch(`https://assets.opendaw.studio/samples/${id}`)
            if (response.ok) {
                writeFileSync(file, new Uint8Array(await response.arrayBuffer()))
            } else {
                const frames = 24000
                const data = new Float32Array(new SharedArrayBuffer(frames * Float32Array.BYTES_PER_ELEMENT))
                let seed = 0x12345678
                for (let index = 0; index < frames; index++) {
                    seed = (seed * 1664525 + 1013904223) >>> 0
                    data[index] = ((seed / 0xFFFFFFFF) * 2 - 1) * Math.exp(-6 * index / frames) * 0.5
                }
                writeFileSync(file, new Uint8Array(WavFile.encodeFloats({frames: [data], numberOfFrames: frames, numberOfChannels: 1, sampleRate: 48000})))
            }
        }
        const bytes = readFileSync(file)
        samples.push({uuid, wav: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer})
    }
    return samples
}

const feedSamples = (engine: any, memory: WebAssembly.Memory, samples: ReadonlyArray<{uuid: UUID.Bytes, wav: ArrayBuffer}>): void => {
    for (; ;) {
        const reserve = engine.input_reserve(16)
        const handle = engine.sample_take_request(reserve)
        if (handle < 0) {break}
        const id = UUID.toString(new Uint8Array(memory.buffer.slice(reserve, reserve + 16)) as UUID.Bytes)
        const found = samples.find(sample => UUID.toString(sample.uuid) === id)
        if (found === undefined) {throw new Error(`engine requested unknown sample ${id}`)}
        const audio = WavFile.decodeFloats(found.wav)
        const pointer = engine.sample_allocate(handle, audio.numberOfFrames * audio.numberOfChannels * 4)
        for (let channel = 0; channel < audio.numberOfChannels; channel++) {
            new Float32Array(memory.buffer, pointer + channel * audio.numberOfFrames * 4, audio.numberOfFrames).set(audio.frames[channel])
        }
        engine.sample_set_ready(handle, audio.numberOfFrames, audio.numberOfChannels, audio.sampleRate)
    }
}

type Slot = {label: string, ptr: number, len: number}

const readFloatSlots = (engine: any, memory: WebAssembly.Memory): Array<Slot> => {
    const count = engine.broadcast_count() >>> 0
    const slots: Array<Slot> = []
    for (let index = 0; index < count; index++) {
        const recordPtr = engine.input_reserve(48)
        if (engine.broadcast_entry(index, recordPtr) === 0) {continue}
        const record = new DataView(memory.buffer, recordPtr, 48)
        const packageType = record.getUint32(16, true)
        if (packageType !== 0 && packageType !== 1) {continue} // floats only (the meter/param packages)
        const uuid = UUID.toString(new Uint8Array(memory.buffer.slice(recordPtr, recordPtr + 16)) as UUID.Bytes).slice(0, 8)
        const keysCount = record.getUint32(28, true)
        const keys: Array<number> = []
        for (let position = 0; position < keysCount; position++) {keys.push(record.getUint16(32 + position * 2, true))}
        slots.push({label: `${uuid}/[${keys.join(",")}]`, ptr: record.getUint32(20, true), len: record.getUint32(24, true)})
    }
    return slots
}

describe("80s.od live clip playback scan", () => {
    it("session fuzz: toggles, seeks, volume edits and freeze/unfreeze stay finite", async () => {
        const boxGraph = decode()
        registerScripts(boxGraph)
        const samples = await fetchSamples(boxGraph)
        const clips = boxGraph.boxes().filter((box): box is NoteClipBox => box instanceof NoteClipBox)
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, boxGraph)
        await sync.settle(); engine.bind(); await sync.settle()
        feedSamples(engine, memory, samples)
        await sync.settle()
        engine.set_metronome_enabled(0)
        for (const clip of clips) {
            const pointer = engine.input_reserve(16)
            new Uint8Array(memory.buffer, pointer, 16).set(clip.address.uuid)
            engine.schedule_clip_play()
        }
        engine.play()
        const devices = boxGraph.boxes().filter(box => box.name.endsWith("DeviceBox"))
        const units = boxGraph.boxes().filter(box => box.name === "AudioUnitBox")
        const instrumentUnits = units.filter(box => (box as unknown as {type: {getValue(): string}}).type.getValue() === "instrument")
        const frozen = new Set<string>()
        let state = 0x9e3779b9 | 0
        const random = (): number => {
            state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state |= 0
            return state >>> 0
        }
        const len = engine.output_len() >>> 0
        const offences: Array<string> = []
        const flagged = new Set<string>()
        let generation = -1
        let slots: Array<Slot> = []
        const scan = (step: number): void => {
            const currentGeneration = engine.broadcast_generation() >>> 0
            if (currentGeneration !== generation) {
                generation = currentGeneration
                slots = readFloatSlots(engine, memory)
            }
            const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
            for (let index = 0; index < len; index++) {
                if (!Number.isFinite(out[index]) && !flagged.has("main")) {
                    flagged.add("main")
                    offences.push(`main output ${out[index]} @ step ${step} sample ${index}`)
                }
            }
            for (const slot of slots) {
                if (flagged.has(slot.label)) {continue}
                const values = new Float32Array(memory.buffer, slot.ptr, slot.len)
                for (let index = 0; index < slot.len; index++) {
                    const value = values[index]
                    if (!Number.isFinite(value) || (slot.len === 4 && value < 0.0)) {
                        flagged.add(slot.label)
                        offences.push(`slot ${slot.label}[${index}] = ${value} @ step ${step}`)
                        break
                    }
                }
            }
        }
        const journal: Array<string> = []
        for (let step = 0; step < 200; step++) {
            const action = random() % 5
            if (action === 0) {
                const pick = random() % devices.length
                const device = devices[pick] as unknown as {enabled: {getValue(): boolean, setValue(value: boolean): void}}
                journal.push(`step ${step}: toggle ${devices[pick].name}`)
                boxGraph.beginTransaction(); device.enabled.setValue(!device.enabled.getValue()); boxGraph.endTransaction()
                await sync.settle()
            } else if (action === 1) {
                journal.push(`step ${step}: seek`)
                engine.set_position((random() % 491520))
            } else if (action === 2) {
                journal.push(`step ${step}: volume`)
                const unit = units[random() % units.length] as unknown as {volume: {setValue(value: number): void}}
                boxGraph.beginTransaction(); unit.volume.setValue(((random() % 1000) / 1000) * 78 - 72); boxGraph.endTransaction()
                await sync.settle()
            } else if (action === 3) {
                const unit = instrumentUnits[random() % instrumentUnits.length]
                const id = unit.address.toString()
                journal.push(`step ${step}: ${frozen.has(id) ? "unfreeze" : "freeze"}`)
                if (frozen.has(id)) {
                    const pointer = engine.input_reserve(16)
                    new Uint8Array(memory.buffer, pointer, 16).set(unit.address.uuid)
                    engine.clear_frozen_audio()
                    frozen.delete(id)
                } else {
                    const frames = 48000
                    const pcm = engine.frozen_allocate(frames, 2)
                    const staging = new Float32Array(memory.buffer, pcm, frames * 2)
                    for (let index = 0; index < frames; index++) {
                        const value = Math.sin(index * 440 / 48000 * Math.PI * 2) * 0.5
                        staging[index] = value; staging[frames + index] = value
                    }
                    const pointer = engine.input_reserve(16)
                    new Uint8Array(memory.buffer, pointer, 16).set(unit.address.uuid)
                    engine.set_frozen_audio(frames, 2, 48000)
                    frozen.add(id)
                }
            } // action 4: just render
            for (let quantum = 0; quantum < 40; quantum++) {engine.render(); scan(step)}
        }
        offences.forEach(offence => console.log("OFFENCE:", offence))
        if (offences.length > 0) {console.log(journal.join("\n"))}
        expect(offences).toEqual([])
        engine.stop()
    }, 600_000)

    it("main output and every float broadcast slot stay finite (and peaks non-negative)", async () => {
        const boxGraph = decode()
        registerScripts(boxGraph)
        const samples = await fetchSamples(boxGraph)
        const timeline = boxGraph.boxes().find(box => box instanceof TimelineBox) as TimelineBox
        const bpm = (timeline as unknown as {bpm: {getValue(): number}}).bpm.getValue()
        const clips = boxGraph.boxes().filter((box): box is NoteClipBox => box instanceof NoteClipBox)
        expect(clips.length).toBeGreaterThan(0)
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, boxGraph)
        await sync.settle(); engine.bind(); await sync.settle()
        feedSamples(engine, memory, samples)
        await sync.settle()
        engine.set_metronome_enabled(0)
        for (const clip of clips) {
            const pointer = engine.input_reserve(16)
            new Uint8Array(memory.buffer, pointer, 16).set(clip.address.uuid)
            engine.schedule_clip_play()
        }
        engine.play()
        const seconds = 80 // one full pass of 80s.od; the clips loop, so re-rendering past the song adds no coverage
        const quanta = Math.ceil(seconds * 48_000 / QUANTUM)
        let generation = -1
        let slots: Array<Slot> = []
        const offences: Array<string> = []
        const flagged = new Set<string>()
        const len = engine.output_len() >>> 0
        let peak = 0
        for (let quantum = 0; quantum < quanta; quantum++) {
            engine.render()
            const currentGeneration = engine.broadcast_generation() >>> 0
            if (currentGeneration !== generation) {
                generation = currentGeneration
                slots = readFloatSlots(engine, memory)
            }
            const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
            for (let index = 0; index < len; index++) {
                const value = out[index]
                if (!Number.isFinite(value) && !flagged.has("main")) {
                    flagged.add("main")
                    offences.push(`main output ${value} @ quantum ${quantum} (${(quantum * QUANTUM / 48_000).toFixed(2)} s) sample ${index}`)
                }
                if (Math.abs(value) > peak) {peak = Math.abs(value)}
            }
            for (const slot of slots) {
                if (flagged.has(slot.label)) {continue}
                const values = new Float32Array(memory.buffer, slot.ptr, slot.len)
                for (let index = 0; index < slot.len; index++) {
                    const value = values[index]
                    // a NEGATIVE meter value is as fatal as NaN in the UI: gainToDb(negative) = NaN
                    if (!Number.isFinite(value) || (slot.len === 4 && value < 0.0)) {
                        flagged.add(slot.label)
                        offences.push(`slot ${slot.label}[${index}] = ${value} @ quantum ${quantum} (${(quantum * QUANTUM / 48_000).toFixed(2)} s)`)
                        break
                    }
                }
            }
        }
        console.log(`bpm ${bpm}, ${quanta} quanta, main peak ${peak.toFixed(3)}`)
        offences.forEach(offence => console.log("OFFENCE:", offence))
        expect(peak, "the launched clips are audible").toBeGreaterThan(0.01)
        expect(offences).toEqual([])
        engine.stop()
    }, 600_000)
})
