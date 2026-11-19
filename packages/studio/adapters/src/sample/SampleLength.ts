import {quantizeRound} from "@opendaw/lib-std"
import {bpm, ppqn, PPQN, seconds} from "@opendaw/lib-dsp"
import {SampleMetaData} from "./SampleMetaData"

export namespace SampleLength {
    const GridTolerance: ppqn = PPQN.SemiQuaver * 0.01

    // warp markers store int32
    export const wholePulses = (duration: seconds, tempo: bpm): ppqn =>
        Math.max(1, Math.round(PPQN.secondsToPulses(duration, tempo)))

    // recordings keep their length, other audio snaps to sixteenths only when it already sits on that grid
    export const musicalPulses = (duration: seconds, tempo: bpm, origin: SampleMetaData["origin"]): ppqn => {
        const pulses = PPQN.secondsToPulses(duration, tempo)
        const whole = wholePulses(duration, tempo)
        if (origin === "recording" || pulses < PPQN.SemiQuaver) {return whole}
        const snapped = quantizeRound(pulses, PPQN.SemiQuaver)
        return Math.abs(snapped - pulses) <= GridTolerance ? snapped : whole
    }
}
