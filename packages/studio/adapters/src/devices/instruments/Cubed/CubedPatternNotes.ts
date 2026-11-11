import {clamp, int, unitValue} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {CubedPatternData} from "./CubedPatternData"
import {CubedStep} from "./CubedStep"

// a pattern as notes, the way the engine plays it (crates/stock-devices/device-cubed/src/pattern.rs)
export namespace CubedPatternNotes {
    export type Note = {
        readonly position: ppqn
        readonly duration: ppqn
        readonly pitch: int
        readonly velocity: unitValue
    }

    export const StepDuration: ppqn = PPQN.SemiQuaver
    export const GateDuration: ppqn = Math.round(StepDuration * 0.551704)
    export const SlideDuration: ppqn = Math.round(StepDuration * 1.05)
    export const PlainVelocity: unitValue = 0.5
    export const AccentVelocity: unitValue = 1.0
    export const AccentThreshold: unitValue = 100.0 / 127.0

    export const durationOf = ({length}: CubedPatternData): ppqn => length * StepDuration

    export const toNotes = ({length, steps}: CubedPatternData): ReadonlyArray<Note> => steps.slice(0, length)
        .flatMap(({note, active, slide, accent}, index) => active ? [{
            position: index * StepDuration,
            duration: slide ? SlideDuration : GateDuration,
            pitch: note,
            velocity: accent ? AccentVelocity : PlainVelocity
        }] : [])

    // silent steps keep the steps of `previous`, so exporting and importing into the same pattern changes nothing
    export const fromNotes = (notes: ReadonlyArray<Note>, duration: ppqn, previous: CubedPatternData): CubedPatternData => {
        const length = clamp(Math.round(duration / StepDuration), 1, CubedPatternData.MaxSteps)
        const steps: Array<CubedStep> = Array.from({length}, (_, index) => ({
            ...(previous.steps[index] ?? {note: CubedStep.DefaultNote, slide: false, accent: false}), active: false
        }))
        notes.filter(({position}) => position >= 0 && position < length * StepDuration)
            .toSorted((left, right) => left.position - right.position)
            .forEach(({position, duration, pitch, velocity}) => {
                const index = clamp(Math.round(position / StepDuration), 0, length - 1)
                steps[index] = {
                    note: clamp(pitch, 0, 127),
                    active: true,
                    slide: position + duration > (index + 1) * StepDuration,
                    accent: velocity >= AccentThreshold
                }
            })
        return {length, steps}
    }
}
