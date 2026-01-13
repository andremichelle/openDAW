import {Option, UUID} from "@moises-ai/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@moises-ai/lib-box"
import {Pointers} from "@moises-ai/studio-enums"
import {UnknownAudioEffectDeviceBox} from "@moises-ai/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"

export class UnknownAudioEffectDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = ""

    readonly #context: BoxAdaptersContext
    readonly #box: UnknownAudioEffectDeviceBox

    constructor(context: BoxAdaptersContext, box: UnknownAudioEffectDeviceBox) {
        this.#context = context
        this.#box = box
    }

    get box(): UnknownAudioEffectDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}
    get commentField(): StringField {return this.#box.comment}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    *labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {}
}