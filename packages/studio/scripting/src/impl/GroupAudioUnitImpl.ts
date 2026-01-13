import {AuxAudioUnit, GroupAudioUnit, Send} from "../Api"
import {AudioUnitImpl} from "./AudioUnitImpl"
import {SendImpl} from "./SendImpl"
import {Arrays} from "@moises-ai/lib-std"

export class GroupAudioUnitImpl extends AudioUnitImpl implements GroupAudioUnit {
    readonly kind = "group" as const
    readonly #sends: Array<SendImpl> = []

    label: string

    constructor(props?: Partial<GroupAudioUnit>) {
        super(props)

        this.label = props?.label ?? "Subgroup"
    }

    addSend(target: AuxAudioUnit | GroupAudioUnit, props?: Partial<Send>): Send {
        const send = new SendImpl(target, props)
        this.#sends.push(send)
        return send
    }

    removeSend(send: Send): void {Arrays.remove(this.#sends, send)}

    get sends(): ReadonlyArray<SendImpl> {return this.#sends}
}
