import {Address} from "@opendaw/lib-box"

export type LabeledAudioOutput = { readonly address: Address, readonly label: string }

export interface LabeledAudioOutputsOwner {
    labeledAudioOutputs(): Iterable<LabeledAudioOutput>
}