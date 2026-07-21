import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {AutotuneDeviceBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class AutotuneDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.Autotune

    readonly #context: BoxAdaptersContext
    readonly #box: AutotuneDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: AutotuneDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): AutotuneDeviceBox {return this.#box}
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

    #wrapParameters(box: AutotuneDeviceBox) {
        return {
            key: this.#parametric.createParameter(
                box.key,
                ValueMapping.linearInteger(0, 11),
                StringMapping.indices("", ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]),
                "Key"),
            scale: this.#parametric.createParameter(
                box.scale,
                ValueMapping.linearInteger(0, 7),
                StringMapping.indices("", ["Chrom", "Major", "Minor", "MajPent", "MinPent", "Blues", "Dorian", "Mixo"]),
                "Scale"),
            amount: this.#parametric.createParameter(
                box.amount,
                ValueMapping.unipolar(),
                StringMapping.percent(), "Amount"),
            retune: this.#parametric.createParameter(
                box.retune,
                ValueMapping.unipolar(),
                StringMapping.percent(), "Retune"),
            smooth: this.#parametric.createParameter(
                box.smooth,
                ValueMapping.unipolar(),
                StringMapping.percent(), "Smooth"),
            shift: this.#parametric.createParameter(
                box.shift,
                ValueMapping.linear(-12.0, 12.0),
                StringMapping.numeric({unit: "st"}), "Shift")
        } as const
    }
}
