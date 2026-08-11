import {int} from "@opendaw/lib-std"

export type CubedStep = {
    note: int      // MIDI note 0..127; slide carries the tie
    active: boolean
    slide: boolean
    accent: boolean
}

export namespace CubedStep {
    export const DefaultNote: int = 60

    // one int32 per step: midi-note 0..6, active 7, slide 8, accent 9
    export const pack = (step: CubedStep): int =>
        (step.note & 0x7F)
        | ((step.active ? 1 : 0) << 7)
        | ((step.slide ? 1 : 0) << 8)
        | ((step.accent ? 1 : 0) << 9)

    export const unpack = (bits: int): CubedStep => ({
        note: bits & 0x7F,
        active: ((bits >> 7) & 1) === 1,
        slide: ((bits >> 8) & 1) === 1,
        accent: ((bits >> 9) & 1) === 1
    })
}
