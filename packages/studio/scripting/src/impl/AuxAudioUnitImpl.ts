import {AuxAudioUnit, GroupAudioUnit, Send} from "../Api"
import {AudioUnitImpl} from "./AudioUnitImpl"
import {SendImpl} from "./SendImpl"
import {Arrays} from "@moises-ai/lib-std"

export class AuxAudioUnitImpl extends AudioUnitImpl implements AuxAudioUnit {
    readonly kind = "auxiliary" as const

    readonly #sends: Array<SendImpl> = []

    label: string

    constructor(props?: Partial<GroupAudioUnit>) {
        super(props)

        this.label = props?.label ?? "Fx Track"
    }

    addSend(target: AuxAudioUnit | GroupAudioUnit, props?: Partial<Send>): Send {
        const send = new SendImpl(target, props)
        this.#sends.push(send)
        return send
    }

    removeSend(send: Send): void {Arrays.remove(this.#sends, send)}

    get sends(): ReadonlyArray<SendImpl> {return this.#sends}
}
