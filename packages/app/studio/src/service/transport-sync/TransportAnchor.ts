import {bpm, ppqn, PPQN} from "@opendaw/lib-dsp"

// Phase 1 prototype (see plans/opendaw-shared-transport-plan.md): a shared anchor that
// each client uses to independently recompute its own playback position, instead of
// negotiating a continuous clock. `epoch` is Date.now() when the anchor was set.
export type TransportAnchor = {
    playing: boolean
    epoch: number
    anchorPosition: ppqn
    bpm: bpm
}

export const TransportAnchor = {
    recompute: (anchor: TransportAnchor, now: number = Date.now()): ppqn =>
        anchor.playing ? anchor.anchorPosition + PPQN.secondsToPulses((now - anchor.epoch) / 1000, anchor.bpm) : anchor.anchorPosition
} as const
