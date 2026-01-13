import {ReverbDeviceBox} from "@moises-ai/studio-boxes"
import {Option, StringMapping, UUID, ValueMapping} from "@moises-ai/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@moises-ai/lib-box"
import {Pointers} from "@moises-ai/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class ReverbDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.Reverb

    readonly #context: BoxAdaptersContext
    readonly #box: ReverbDeviceBox
    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: ReverbDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): ReverbDeviceBox {return this.#box}
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

    #wrapParameters(box: ReverbDeviceBox) {
        return {
            decay: this.#parametric.createParameter(
                box.decay,
                ValueMapping.unipolar(),
                StringMapping.numeric({unit: "%", fractionDigits: 0}),
                "Room-Size"),
            preDelay: this.#parametric.createParameter(
                box.preDelay,
                ValueMapping.exponential(0.001, 0.500),
                StringMapping.numeric({
                    unit: "s", fractionDigits: 1, unitPrefix: true
                }),
                "Pre-Delay"),
            damp: this.#parametric.createParameter(
                box.damp,
                ValueMapping.unipolar(),
                StringMapping.numeric({unit: "%", fractionDigits: 0}),
                "damping"),
            filter: this.#parametric.createParameter(
                box.filter,
                ValueMapping.bipolar(),
                StringMapping.numeric({unit: "%", fractionDigits: 0}),
                "filter"),
            dry: this.#parametric.createParameter(
                box.dry,
                ValueMapping.DefaultDecibel,
                StringMapping.numeric({unit: "db", fractionDigits: 1}),
                "dry"),
            wet: this.#parametric.createParameter(
                box.wet,
                ValueMapping.DefaultDecibel,
                StringMapping.numeric({unit: "db", fractionDigits: 1}),
                "wet")
        } as const
    }
}