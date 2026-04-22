import {describe, expect, it} from "vitest"
import {LoopableRegion} from "./events"
import {ConstantTempoMap} from "./ConstantTempoMap"
import {PPQN} from "./ppqn"

describe("LoopableRegion cut-and-move scenario", () => {
    const barPpqn = 4 * PPQN.Quarter
    const bpm = 120

    it("split region keeps its sample-content offset via loopOffset", () => {
        const region = {
            position: 6 * barPpqn,
            complete: 10 * barPpqn,
            loopOffset: 6 * barPpqn,
            loopDuration: 16 * barPpqn
        }
        const cycles = [...LoopableRegion.locateLoops(region, 6 * barPpqn, 10 * barPpqn)]
        expect(cycles.length).toBe(1)
        const cycle = cycles[0]
        expect(cycle.rawStart).toBe(0)
        expect(cycle.resultStart).toBe(6 * barPpqn)
        expect(cycle.resultEnd).toBe(10 * barPpqn)
    })

    it("moved region (position < loopOffset) produces a negative rawStart", () => {
        const region = {
            position: 5 * barPpqn,
            complete: 9 * barPpqn,
            loopOffset: 6 * barPpqn,
            loopDuration: 16 * barPpqn
        }
        const cycles = [...LoopableRegion.locateLoops(region, 5 * barPpqn, 9 * barPpqn)]
        expect(cycles.length).toBe(1)
        const cycle = cycles[0]
        expect(cycle.rawStart).toBe(-1 * barPpqn)
        expect(cycle.resultStart).toBe(5 * barPpqn)
        expect(cycle.resultEnd).toBe(9 * barPpqn)
    })

    it("moved-to-zero region produces rawStart equal to -loopOffset", () => {
        const region = {
            position: 0,
            complete: 4 * barPpqn,
            loopOffset: 6 * barPpqn,
            loopDuration: 16 * barPpqn
        }
        const cycles = [...LoopableRegion.locateLoops(region, 0, 4 * barPpqn)]
        expect(cycles.length).toBe(1)
        const cycle = cycles[0]
        expect(cycle.rawStart).toBe(-6 * barPpqn)
        expect(cycle.resultStart).toBe(0)
    })
})

describe("TempoMap.intervalToSeconds with negative fromPPQN", () => {
    const barPpqn = 4 * PPQN.Quarter
    const bpm = 120

    it("ConstantTempoMap returns correct elapsed seconds across ppqn=0", () => {
        const tempoMap = new ConstantTempoMap({
            getValue: () => bpm,
            subscribe: () => ({terminate: () => {}})
        } as any)
        const elapsed = tempoMap.intervalToSeconds(-1 * barPpqn, 5 * barPpqn)
        const expected = PPQN.pulsesToSeconds(6 * barPpqn, bpm)
        expect(elapsed).toBeCloseTo(expected)
    })

    it("ConstantTempoMap handles negative intervals consistently with ppqnToSeconds", () => {
        const tempoMap = new ConstantTempoMap({
            getValue: () => bpm,
            subscribe: () => ({terminate: () => {}})
        } as any)
        expect(tempoMap.intervalToSeconds(-6 * barPpqn, 0))
            .toBeCloseTo(PPQN.pulsesToSeconds(6 * barPpqn, bpm))
    })
})

describe("no-stretch sample offset for moved split region", () => {
    const barPpqn = 4 * PPQN.Quarter
    const bpm = 120
    const dataSampleRate = 48000
    const tempoMap = new ConstantTempoMap({
        getValue: () => bpm,
        subscribe: () => ({terminate: () => {}})
    } as any)

    const computeSampleOffset = (region: {position: number, complete: number, loopOffset: number, loopDuration: number},
                                 waveformOffset: number) => {
        const cycles = [...LoopableRegion.locateLoops(region, region.position, region.complete)]
        const cycle = cycles[0]
        const elapsedSeconds = tempoMap.intervalToSeconds(cycle.rawStart, cycle.resultStart)
        return (elapsedSeconds + waveformOffset) * dataSampleRate
    }

    it("middle region moved to 0 plays sample from 6-bar mark", () => {
        const offset = computeSampleOffset({
            position: 0,
            complete: 4 * barPpqn,
            loopOffset: 6 * barPpqn,
            loopDuration: 16 * barPpqn
        }, 0)
        const expected = PPQN.pulsesToSeconds(6 * barPpqn, bpm) * dataSampleRate
        expect(offset).toBeCloseTo(expected)
    })

    it("middle region moved to bar 5 plays sample from 6-bar mark", () => {
        const offset = computeSampleOffset({
            position: 5 * barPpqn,
            complete: 9 * barPpqn,
            loopOffset: 6 * barPpqn,
            loopDuration: 16 * barPpqn
        }, 0)
        const expected = PPQN.pulsesToSeconds(6 * barPpqn, bpm) * dataSampleRate
        expect(offset).toBeCloseTo(expected)
    })
})
