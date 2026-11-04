// The engine reports every discontinuous block of a quantum (`transport_jump_*`) and the sample
// `pauseOnLoopDisabled` paused at (`transport_pause_sample`), so the worklet can stamp a loop wrap at the
// exact sample instead of the main thread guessing it from a position that went backwards.
import {describe, expect, it} from "vitest"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

// 44.1 kHz at 120 bpm: a bar is 88200 samples, 689 quanta and 8 samples
const BAR = 3840

const build = (loopTo: number) => {
    const skeleton = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const {boxGraph: source, mandatoryBoxes: {timelineBox}} = skeleton
    source.beginTransaction()
    timelineBox.loopArea.from.setValue(0)
    timelineBox.loopArea.to.setValue(loopTo)
    timelineBox.loopArea.enabled.setValue(true)
    source.endTransaction()
    return source
}

type Jump = { quantum: number, sample: number, position: number }

const boot = async (loopTo: number) => {
    const {engine, memory} = await loadFullEngine(44100)
    const sync = connectSyncToEngine(engine, memory, build(loopTo))
    await sync.settle(); engine.bind(); await sync.settle()
    const render = (quanta: number) => {
        const jumps: Array<Jump> = []
        const pauses: Array<{quantum: number, sample: number}> = []
        for (let quantum = 0; quantum < quanta; quantum++) {
            engine.render()
            const count = engine.transport_jump_count() >>> 0
            for (let index = 0; index < count; index++) {
                jumps.push({quantum, sample: engine.transport_jump_sample(index) >>> 0, position: engine.transport_jump_position(index)})
            }
            const pause = engine.transport_pause_sample() | 0
            if (pause >= 0) {pauses.push({quantum, sample: pause})}
        }
        return {jumps, pauses}
    }
    return {engine, render}
}

describe("transport jumps", () => {
    it("reports a recording loop wrap at its sample inside the quantum", async () => {
        const {engine, render} = await boot(BAR)
        engine.set_allow_takes(1)
        engine.prepare_recording_state(0, 1.0)
        const {jumps, pauses} = render(1400)
        const wraps = jumps.filter(({quantum}) => quantum > 0)
        expect(wraps.map(({quantum, sample}) => quantum * 128 + sample)).toEqual([88200, 176400])
        expect(wraps.every(({position}) => position === 0)).toBe(true)
        expect(pauses).toEqual([])
    }, 60000)

    it("reports several wraps inside one quantum", async () => {
        const {engine, render} = await boot(2) // 2 pulses are 45.94 samples
        engine.play()
        const {jumps} = render(1)
        // the engine renders each lap in whole samples
        expect(jumps.filter(({sample}) => sample > 0).map(({sample}) => sample)).toEqual([45, 90])
    }, 60000)

    it("reports the sample pauseOnLoopDisabled paused at", async () => {
        const {engine, render} = await boot(BAR)
        engine.set_pause_on_loop_disabled(1)
        engine.set_allow_takes(1)
        engine.prepare_recording_state(0, 1.0)
        const {pauses} = render(700)
        expect(pauses).toEqual([{quantum: 689, sample: 8}])
    }, 60000)
})
