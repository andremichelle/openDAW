import {NoteEvent} from "../Api"
import {ppqn} from "@moises-ai/lib-dsp"

export class NoteEventImpl implements NoteEvent {
    position: ppqn
    duration: ppqn
    pitch: number
    cents: number
    velocity: number

    constructor(props?: Partial<NoteEvent>) {
        this.position = props?.position ?? 0.0
        this.duration = props?.duration ?? PPQN.SemiQuaver
        this.pitch = props?.pitch ?? 60
        this.cents = props?.cents ?? 0
        this.velocity = props?.velocity ?? 1.0
    }
}
