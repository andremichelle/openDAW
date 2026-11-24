import {NoteEvent, ppqn} from "@opendaw/lib-dsp"
import {int, Option} from "@opendaw/lib-std"
import {NoteEventGroupBox} from "@opendaw/studio-boxes"

export type UINoteEvent = NoteEvent & {
    isSelected: boolean
    complete: ppqn
    chance: number
    playCount: int
    playCurve: number
    group: Option<NoteEventGroupBox>
}