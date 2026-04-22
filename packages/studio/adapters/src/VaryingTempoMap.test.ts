import {describe, expect, it} from "vitest"
import {ConstantTempoMap, PPQN} from "@opendaw/lib-dsp"

describe("intervalToSeconds across ppqn=0", () => {
    const barPpqn = 4 * PPQN.Quarter
    const bpm = 120

    it("returns full span for negative fromPPQN", () => {
        const tempoMap = new ConstantTempoMap({
            getValue: () => bpm,
            subscribe: () => ({terminate: () => {}})
        } as any)
        const elapsed = tempoMap.intervalToSeconds(-6 * barPpqn, 0)
        expect(elapsed).toBeCloseTo(PPQN.pulsesToSeconds(6 * barPpqn, bpm))
    })

    it("returns full span for interval straddling zero", () => {
        const tempoMap = new ConstantTempoMap({
            getValue: () => bpm,
            subscribe: () => ({terminate: () => {}})
        } as any)
        const elapsed = tempoMap.intervalToSeconds(-1 * barPpqn, 5 * barPpqn)
        expect(elapsed).toBeCloseTo(PPQN.pulsesToSeconds(6 * barPpqn, bpm))
    })
})
