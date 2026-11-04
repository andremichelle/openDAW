// The processor turns the post-render engine state plus the engine's jumps inside the quantum into
// transport anchors in context time (see src/transport-anchor-edges.ts).
import {describe, expect, it} from "vitest"
import {QuantumTransport, TransportAnchorEdges} from "../src/transport-anchor-edges"

const SAMPLE_RATE = 48_000
const quantum = (frame: number, partial: Partial<QuantumTransport>): QuantumTransport => ({
    frame, sampleRate: SAMPLE_RATE, isPlaying: true, isRecording: false, position: 0, jumps: [], pauseSample: -1, ...partial
})

describe("TransportAnchorEdges", () => {
    it("anchors the start at the end of the first playing quantum", () => {
        const edges = new TransportAnchorEdges()
        expect(edges.observe(quantum(0, {isPlaying: false}))).toEqual([])
        expect(edges.observe(quantum(128, {position: 7.5}))).toEqual([
            {kind: "start", contextTime: 256 / SAMPLE_RATE, position: 7.5, recording: false}])
        expect(edges.observe(quantum(256, {position: 15}))).toEqual([])
    })

    it("stamps a loop wrap at its sample inside the quantum", () => {
        const edges = new TransportAnchorEdges()
        edges.observe(quantum(0, {}))
        expect(edges.observe(quantum(128, {isRecording: true, jumps: [{sample: 40, position: 0}]}))).toEqual([
            {kind: "jump", contextTime: 168 / SAMPLE_RATE, position: 0, recording: true}])
    })

    it("reports every wrap of a quantum in order", () => {
        const edges = new TransportAnchorEdges()
        edges.observe(quantum(0, {}))
        const anchors = edges.observe(quantum(128, {jumps: [{sample: 10, position: 0}, {sample: 90, position: 0}]}))
        expect(anchors.map(({contextTime}) => contextTime * SAMPLE_RATE)).toEqual([138, 218])
    })

    it("stops at the sample pauseOnLoopDisabled paused at and keeps the recording flag of that quantum", () => {
        const edges = new TransportAnchorEdges()
        edges.observe(quantum(0, {isRecording: true}))
        expect(edges.observe(quantum(128, {isPlaying: false, isRecording: false, position: 3840, pauseSample: 77})))
            .toEqual([{kind: "stop", contextTime: 205 / SAMPLE_RATE, position: 3840, recording: true}])
    })

    it("stops at the quantum start when the transport did not play in it", () => {
        const edges = new TransportAnchorEdges()
        edges.observe(quantum(0, {position: 20}))
        expect(edges.observe(quantum(128, {isPlaying: false, position: 0}))).toEqual([
            {kind: "stop", contextTime: 128 / SAMPLE_RATE, position: 20, recording: false}])
    })

    it("closes a playing transport once on a stop command", () => {
        const edges = new TransportAnchorEdges()
        edges.observe(quantum(0, {position: 20}))
        expect(edges.close(1.0).unwrap()).toEqual({kind: "stop", contextTime: 1.0, position: 20, recording: false})
        expect(edges.close(2.0).isEmpty()).toBe(true)
        expect(edges.observe(quantum(256, {position: 30}))[0].kind, "a play right after the stop starts again")
            .toBe("start")
    })
})
