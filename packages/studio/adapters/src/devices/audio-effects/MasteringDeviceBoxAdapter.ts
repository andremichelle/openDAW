import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {MasteringDeviceBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class MasteringDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.Mastering

    readonly #context: BoxAdaptersContext
    readonly #box: MasteringDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: MasteringDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): MasteringDeviceBox {return this.#box}
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

    terminate(): void {this.#parametric.terminate()}

    #wrapParameters(box: MasteringDeviceBox) {
        return {
            amount: this.#parametric.createParameter(
                box.amount, ValueMapping.unipolar(),
                StringMapping.percent({fractionDigits: 0}), "Amount"),
            gain: this.#parametric.createParameter(
                box.gain, ValueMapping.linear(-12.0, 12.0),
                StringMapping.numeric({unit: "dB", fractionDigits: 1}), "Gain", 0.5),
            width: this.#parametric.createParameter(
                box.width, ValueMapping.linear(0.0, 2.0),
                StringMapping.percent({fractionDigits: 0}), "Width", 0.5),
            ceiling: this.#parametric.createParameter(
                box.ceiling, ValueMapping.linear(-6.0, 0.0),
                StringMapping.numeric({unit: "dB", fractionDigits: 2}), "Ceiling", 1.0)
        } as const
    }
}
