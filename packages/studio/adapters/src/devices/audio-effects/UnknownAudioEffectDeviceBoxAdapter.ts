import {UUID} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {UnknownAudioEffectDeviceBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"

export class UnknownAudioEffectDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"

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

    terminate(): void {}
}