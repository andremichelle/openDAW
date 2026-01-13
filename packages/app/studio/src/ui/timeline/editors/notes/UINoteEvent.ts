import {NoteEvent, ppqn} from "@moises-ai/lib-dsp"
import {int} from "@moises-ai/lib-std"

export type UINoteEvent = NoteEvent & {
    isSelected: boolean
    complete: ppqn
    chance: number
    playCount: int
    playCurve: number
}