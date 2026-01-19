import {NeuralAmpDeviceBox} from "@opendaw/studio-boxes"
import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class NeuralAmpDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.NeuralAmp

    readonly #context: BoxAdaptersContext
    readonly #box: NeuralAmpDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter

    constructor(context: BoxAdaptersContext, box: NeuralAmpDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): NeuralAmpDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}
    get modelJsonField(): StringField {return this.#box.modelJson}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    * labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {
        this.#parametric.terminate()
    }

    #wrapParameters(box: NeuralAmpDeviceBox) {
        return {
            inputGain: this.#parametric.createParameter(
                box.inputGain,
                ValueMapping.DefaultDecibel,
                StringMapping.numeric({unit: "dB", fractionDigits: 1}), "input"),
            outputGain: this.#parametric.createParameter(
                box.outputGain,
                ValueMapping.DefaultDecibel,
                StringMapping.numeric({unit: "dB", fractionDigits: 1}), "output")
        } as const
    }
}
