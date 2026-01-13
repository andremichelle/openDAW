import {Option, StringMapping, UUID, ValueMapping} from "@moises-ai/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@moises-ai/lib-box"
import {FoldDeviceBox} from "@moises-ai/studio-boxes"
import {Pointers} from "@moises-ai/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class FoldDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.Fold

    readonly #context: BoxAdaptersContext
    readonly #box: FoldDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: FoldDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): FoldDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    *labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {
        this.#parametric.terminate()
    }

    #wrapParameters(box: FoldDeviceBox) {
        return {
            drive: this.#parametric.createParameter(
                box.drive,
                ValueMapping.linear(0.0, 30.0),
                StringMapping.decible, "Drive"),
            volume: this.#parametric.createParameter(
                box.volume,
                ValueMapping.linear(-18.0, 0.0),
                StringMapping.decible, "Volume")
        } as const
    }
}