// DIAGNOSTIC (user-reported PeakMeter crash after freezing a unit): run the FULL freeze pipeline on real
// project files — the freeze-shaped offline stem render (includeAudioEffects + skipChannelStrip, NO sends),
// then frozen playback in a live engine — and scan every value the UI's meters consume for non-finite /
// negative garbage (`gainToDb(NaN | negative)` = NaN, which crashes the SVG PeakMeter).
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {ApparatDeviceBox, AudioUnitBox, SpielwerkDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const QUANTUM = 128
const FREEZE_FLAGS = 1 | 8 // includeAudioEffects | skipChannelStrip (AudioUnitFreeze: includeSends false)

const decode = (name: string): BoxGraph => {
    const buffer = readFileSync(path.resolve(__dirname, `../../../../test-files/${name}`))
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

const firstInstrumentUnit = (boxGraph: BoxGraph): AudioUnitBox => {
    const units = boxGraph.boxes()
        .filter((box): box is AudioUnitBox => box instanceof AudioUnitBox)
        .filter(box => (box as unknown as {type: {getValue(): string}}).type.getValue() === "instrument")
        .sort((a, b) => a.index.getValue() - b.index.getValue())
    expect(units.length).toBeGreaterThan(0)
    return units[0]
}

const scanNonFinite = (values: Float32Array, label: string): void => {
    for (let index = 0; index < values.length; index++) {
        const value = values[index]
        if (!Number.isFinite(value)) {
            throw new Error(`${label}: non-finite ${value} at ${index}`)
        }
    }
}

// The freeze render: a one-stem offline export (mirrors offline-worker.ts writing [uuid16][flags u32]).
const renderFreezeStem = async (boxGraph: BoxGraph, unit: AudioUnitBox, quanta: number): Promise<Float32Array> => {
    const {engine, memory, drainSamples} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, boxGraph)
    await sync.settle()
    const pointer = engine.input_reserve(20)
    new Uint8Array(memory.buffer, pointer, 16).set(unit.address.uuid)
    new DataView(memory.buffer, pointer, 20).setUint32(16, FREEZE_FLAGS, true)
    engine.set_stem_export(1)
    engine.bind()
    await sync.settle()
    drainSamples()
    await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    const pcm = new Float32Array(quanta * 2 * QUANTUM) // planar per quantum: L128 R128
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        pcm.set(new Float32Array(memory.buffer, engine.stem_output_ptr(), 2 * QUANTUM), quantum * 2 * QUANTUM)
    }
    return pcm
}

// Live playback of the frozen PCM: what the studio engine does after `setFrozenAudio`. Returns nothing —
// throws on the first non-finite master sample or non-finite/negative strip-meter broadcast value.
const playFrozen = async (boxGraph: BoxGraph, unit: AudioUnitBox, stemPcm: Float32Array, quanta: number): Promise<void> => {
    const {engine, memory, drainSamples} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, boxGraph)
    await sync.settle(); engine.bind(); await sync.settle()
    drainSamples()
    await sync.settle()
    engine.set_metronome_enabled(0)
    // Interleave the per-quantum planar staging into whole-length planar L then R (the AudioData layout).
    const frameCount = stemPcm.length / 2
    const frames = new Float32Array(stemPcm.length)
    for (let quantum = 0; quantum < frameCount / QUANTUM; quantum++) {
        for (let index = 0; index < QUANTUM; index++) {
            frames[quantum * QUANTUM + index] = stemPcm[quantum * 2 * QUANTUM + index]
            frames[frameCount + quantum * QUANTUM + index] = stemPcm[quantum * 2 * QUANTUM + QUANTUM + index]
        }
    }
    const freeze = (): void => {
        const pcmPointer = engine.frozen_allocate(frameCount, 2)
        new Float32Array(memory.buffer, pcmPointer, frameCount * 2).set(frames)
        const uuidPointer = engine.input_reserve(16)
        new Uint8Array(memory.buffer, uuidPointer, 16).set(unit.address.uuid)
        engine.set_frozen_audio(frameCount, 2, 48_000)
    }
    const unfreeze = (): void => {
        const uuidPointer = engine.input_reserve(16)
        new Uint8Array(memory.buffer, uuidPointer, 16).set(unit.address.uuid)
        engine.clear_frozen_audio()
    }
    const unitId = UUID.toString(unit.address.uuid)
    const meterSlot = (): Float32Array => {
        const count = engine.broadcast_count()
        for (let index = 0; index < count; index++) {
            const recordPointer = engine.input_reserve(48)
            if (engine.broadcast_entry(index, recordPointer) === 0) {continue}
            const record = new DataView(memory.buffer, recordPointer, 48)
            const uuid = new Uint8Array(memory.buffer, recordPointer, 16).slice() as UUID.Bytes
            const packageType = record.getUint32(16, true)
            const keysCount = record.getUint32(28, true)
            if (packageType === 1 && keysCount === 0 && UUID.toString(uuid) === unitId) {
                return new Float32Array(memory.buffer, record.getUint32(20, true), record.getUint32(24, true))
            }
        }
        throw new Error("frozen unit has no strip-meter broadcast")
    }
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    let peak = 0
    const renderScan = (count: number, phase: string): void => {
        for (let quantum = 0; quantum < count; quantum++) {
            engine.render()
            const output = new Float32Array(memory.buffer, engine.output_ptr(), len)
            scanNonFinite(output, `master output ${phase} @ quantum ${quantum}`)
            const meter = meterSlot()
            scanNonFinite(meter, `strip meter ${phase} @ quantum ${quantum}`)
            meter.forEach(value => expect(value, `meter value ${phase} @ quantum ${quantum}`).toBeGreaterThanOrEqual(0))
            for (const value of output) {peak = Math.max(peak, Math.abs(value))}
        }
    }
    // The studio sequence: live playback, freeze delivered MID-PLAY, unfreeze, freeze again.
    renderScan(128, "live")
    freeze()
    renderScan(quanta, "frozen")
    unfreeze()
    renderScan(128, "unfrozen")
    freeze()
    renderScan(quanta, "refrozen")
    expect(peak, "the unit is audible on the master").toBeGreaterThan(0.01)
}

describe("freeze pipeline on real projects", () => {
    for (const file of ["breakit.od", "atstil.od", "80s.od"]) {
        it(`${file}: freeze render is finite and frozen playback feeds finite meters`, async () => {
            const boxGraph = decode(file)
            registerScripts(boxGraph)
            const unit = firstInstrumentUnit(boxGraph)
            const quanta = 1024 // ~2.7 s @ 48 kHz
            const stemPcm = await renderFreezeStem(boxGraph, unit, quanta)
            scanNonFinite(stemPcm, `${file} freeze stem`)
            await playFrozen(boxGraph, unit, stemPcm, quanta)
        }, 120_000)
    }
})
