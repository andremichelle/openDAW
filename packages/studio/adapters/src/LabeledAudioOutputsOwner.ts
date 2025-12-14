import {Address} from "@opendaw/lib-box"
import {Option, Provider} from "@opendaw/lib-std"

export type LabeledAudioOutput = {
    readonly address: Address
    readonly label: string
    readonly children: Provider<Option<Iterable<LabeledAudioOutput>>>
}

export interface LabeledAudioOutputsOwner {
    labeledAudioOutputs(): Iterable<LabeledAudioOutput>
}