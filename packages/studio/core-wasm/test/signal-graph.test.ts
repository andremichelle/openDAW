// The signal graph report (#482 phase 0): the real engine.wasm lists every processor with its owner and every
// edge, marks a sidechain tap as an ordering-only edge, and reports zero latency without look-ahead.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {CompressorDeviceBox} from "@opendaw/studio-boxes"
import type {AudioUnitBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {buildEffectProject} from "./helpers/effect-harness"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {readSignalGraph} from "../src/engine-exports"

describe("signal graph report", () => {
    it("lists processors, owners and a sidechain as an ordering edge", async () => {
        const holder: { unit: Uint8Array, compressor: Uint8Array } = {unit: new Uint8Array(), compressor: new Uint8Array()}
        const source: BoxGraph = buildEffectProject(0.5, (graph: BoxGraph, unit: AudioUnitBox) => {
            const compressor = CompressorDeviceBox.create(graph, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.index.setValue(0)
                box.lookahead.setValue(false)
            })
            compressor.sideChain.refer(unit)
            holder.unit = unit.address.uuid
            holder.compressor = compressor.address.uuid
            return compressor
        })
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.play()
        engine.render()
        const graph = readSignalGraph(engine, memory)
        expect(graph.sampleRate).toBe(48000)
        expect(graph.maxCompensation).toBe(4800)
        const owned = (uuid: Uint8Array) => graph.nodes.filter(node =>
            node.owner !== null && UUID.equals(node.owner, uuid))
        const compressor = owned(holder.compressor)
        expect(compressor.length).toBe(1)
        expect(compressor[0].label.startsWith("CompressorDeviceBox")).toBe(true)
        const strip = owned(holder.unit).find(node => node.label.startsWith("strip:"))
        expect(strip).toBeDefined()
        const sidechain = graph.edges.find(edge => edge.source === strip?.id && edge.target === compressor[0].id)
        expect(sidechain?.data).toBe(false)
        expect(graph.edges.filter(edge => edge.target === compressor[0].id && edge.data).length).toBe(1)
        expect(graph.nodes.some(node => node.label === "master-sum")).toBe(true)
        expect(graph.nodes.every(node => node.latency === 0 && node.arrival === 0)).toBe(true)
        expect(graph.edges.every(edge => edge.delay === 0)).toBe(true)
        const ids = new Set(graph.nodes.map(node => node.id))
        expect(graph.edges.every(edge => ids.has(edge.source) && ids.has(edge.target))).toBe(true)
    }, 30000)
})
