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

describe("LoopableRegion degenerate loop durations", () => {
    const barPpqn = 4 * PPQN.Quarter

    const region = (loopDuration: number) => ({
        position: 4 * barPpqn,
        complete: 8 * barPpqn,
        loopOffset: 5 * barPpqn,
        loopDuration
    })

    it.each([0, -barPpqn, NaN])("locateLoops terminates and yields nothing (loopDuration=%s)", loopDuration => {
        const cycles = [...LoopableRegion.locateLoops(region(loopDuration), 0, 16 * barPpqn)]
        expect(cycles.length).toBe(0)
    })

    it.each([0, -barPpqn, NaN])("locateLoop finds nothing (loopDuration=%s)", loopDuration => {
        expect(LoopableRegion.locateLoop(region(loopDuration), 0, 16 * barPpqn).isEmpty()).toBe(true)
    })
})

describe("LoopableRegion.loopOffsetAt", () => {
    const beat = PPQN.Quarter
    const region = (position: number, loopOffset: number, loopDuration: number) => ({
        type: "region", position, duration: 16 * beat, complete: position + 16 * beat, loopOffset, loopDuration
    })

    it("keeps a whole tick whole where globalToLocal does not (3/4 bar loop at bar 2, beat 2)", () => {
        const waltz = region(0, 0, 3 * beat)
        expect(LoopableRegion.globalToLocal(waltz, 4 * beat)).toBe(959.9999999999998)
        expect(LoopableRegion.loopOffsetAt(waltz, 4 * beat)).toBe(960)
    })

    it("equals globalToLocal on every 1/16 within 4 bars either side of a 4/4 bar loop's start", () => {
        const bar = 4 * beat
        const loop = region(bar, 2 * beat, bar)
        for (let delta = -4 * bar; delta <= 4 * bar; delta += beat / 4) {
            expect(LoopableRegion.loopOffsetAt(loop, bar + delta)).toBe(LoopableRegion.globalToLocal(loop, bar + delta))
        }
    })

    it.each([1280, 2880, 3840, 11520])("returns a whole tick in [0, loopDuration) for every whole tick (loopDuration=%s)",
        loopDuration => {
            const loop = region(960, 480, loopDuration)
            const misses: Array<number> = []
            for (let at = -30000; at <= 30000; at++) {
                const offset = LoopableRegion.loopOffsetAt(loop, at)
                const congruent = (at - loop.position + loop.loopOffset - offset) % loopDuration === 0
                if (!Number.isInteger(offset) || offset < 0 || offset >= loopDuration || !congruent) {misses.push(at)}
            }
            expect(misses).toEqual([])
        })

    it("wraps a position before the region start and a loopOffset past the loop end", () => {
        expect(LoopableRegion.loopOffsetAt(region(4 * beat, 0, 3 * beat), 0)).toBe(1920)
        expect(LoopableRegion.loopOffsetAt(region(0, 4000, 3 * beat), 0)).toBe(1120)
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
