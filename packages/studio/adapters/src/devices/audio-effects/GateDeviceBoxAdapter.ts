import {GateDeviceBox} from "@moises-ai/studio-boxes"
import {Option, StringMapping, UUID, ValueMapping} from "@moises-ai/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@moises-ai/lib-box"
import {Pointers} from "@moises-ai/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class GateDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.Gate

    readonly #context: BoxAdaptersContext
    readonly #box: GateDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: GateDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): GateDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}
    get sideChain(): PointerField<Pointers.SideChain> {return this.#box.sideChain}

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

    #wrapParameters(box: GateDeviceBox) {
        return {
            inverse: this.#parametric.createParameter(
                box.inverse, ValueMapping.bool, StringMapping.bool, "Inverse"),
            threshold: this.#parametric.createParameter(
                box.threshold, ValueMapping.linear(-80.0, 0.0), StringMapping.decible, "Threshold"),
            return: this.#parametric.createParameter(
                box.return, ValueMapping.linear(0.0, 24.0), StringMapping.decible, "Return"),
            attack: this.#parametric.createParameter(
                box.attack, ValueMapping.linear(0.0, 50.0),
                StringMapping.numeric({unit: "ms", fractionDigits: 1}), "Attack"),
            hold: this.#parametric.createParameter(
                box.hold, ValueMapping.linear(0.0, 500.0),
                StringMapping.numeric({unit: "ms", fractionDigits: 1}), "Hold"),
            release: this.#parametric.createParameter(
                box.release, ValueMapping.linear(1.0, 2000.0),
                StringMapping.numeric({unit: "ms", fractionDigits: 1}), "Release"),
            floor: this.#parametric.createParameter(
                box.floor, ValueMapping.decibel(-72.0, -12.0, 0.0), StringMapping.decible, "Floor")
        } as const
    }
}
