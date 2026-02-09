import {NeuralAmpDeviceBox, NeuralAmpModelBox} from "@opendaw/studio-boxes"
import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {NeuralAmpModelBoxAdapter} from "../../nam/NeuralAmpModelBoxAdapter"

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
    get modelField(): PointerField<Pointers.NeuralAmpModel> {return this.#box.model}
    get monoField(): BooleanField {return this.#box.mono}
    get spectrum(): Address {return this.#box.address.append(0xFFF)}

    getModelAdapter(): Option<NeuralAmpModelBoxAdapter> {
        const target = this.#box.model.targetVertex
        if (target.isEmpty()) {return Option.None}
        return Option.wrap(this.#context.boxAdapters.adapterFor(target.unwrap().box, NeuralAmpModelBoxAdapter))
    }

    getModelJson(): string {
        const modelAdapter = this.getModelAdapter()
        if (modelAdapter.nonEmpty()) {
            return modelAdapter.unwrap().getModelJson()
        }
        return this.#box.modelJson.getValue()
    }

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
                ValueMapping.decibel(-72.0, 0.0, 12.0),
                StringMapping.numeric({unit: "dB", fractionDigits: 1}), "input"),
            outputGain: this.#parametric.createParameter(
                box.outputGain,
                ValueMapping.decibel(-72.0, 0.0, 12.0),
                StringMapping.numeric({unit: "dB", fractionDigits: 1}), "output"),
            mix: this.#parametric.createParameter(
                box.mix, ValueMapping.linear(0.0, 1.0),
                StringMapping.percent(), "Mix")
        } as const
    }
}
