import {bipolar} from "@moises-ai/lib-std"
import {AuxAudioUnit, GroupAudioUnit, Send} from "../Api"

export class SendImpl implements Send {
    readonly target: AuxAudioUnit | GroupAudioUnit

    amount: number
    pan: bipolar
    mode: "pre" | "post"

    constructor(target: AuxAudioUnit | GroupAudioUnit, props?: Partial<Send>) {
        this.target = target
        this.amount = props?.amount ?? 0.0
        this.pan = props?.pan ?? 0.0
        this.mode = props?.mode ?? "post"
    }
}
