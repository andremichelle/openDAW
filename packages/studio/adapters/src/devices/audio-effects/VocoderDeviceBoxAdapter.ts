import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {VocoderDeviceBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export type ModulatorMode =
    | "noise-white"
    | "noise-pink"
    | "noise-brown"
    | "self"
    | "external"

export class VocoderDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.Vocoder

    readonly #context: BoxAdaptersContext
    readonly #box: VocoderDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer

    constructor(context: BoxAdaptersContext, box: VocoderDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): VocoderDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}
    get sideChain(): PointerField<Pointers.SideChain> {return this.#box.sideChain}
    get modulatorSpectrum(): Address {return this.#box.address.append(0xFFE)}
    get carrierSpectrum(): Address {return this.#box.address.append(0xFFF)}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    * labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {this.#parametric.terminate()}

    #wrapParameters(box: VocoderDeviceBox) {
        const freqMap = ValueMapping.exponential(20.0, 20000.0)
        const freqStr = StringMapping.numeric({unit: "Hz", fractionDigits: 0})
        const qMap = ValueMapping.exponential(1.0, 60.0)
        const qStr = StringMapping.numeric({fractionDigits: 1})
        return {
            carrierMinFreq: this.#parametric.createParameter(
                box.carrierMinFreq, freqMap, freqStr, "Carrier Min"),
            carrierMaxFreq: this.#parametric.createParameter(
                box.carrierMaxFreq, freqMap, freqStr, "Carrier Max"),
            modulatorMinFreq: this.#parametric.createParameter(
                box.modulatorMinFreq, freqMap, freqStr, "Mod Min"),
            modulatorMaxFreq: this.#parametric.createParameter(
                box.modulatorMaxFreq, freqMap, freqStr, "Mod Max"),
            qMin: this.#parametric.createParameter(
                box.qMin, qMap, qStr, "Q Min"),
            qMax: this.#parametric.createParameter(
                box.qMax, qMap, qStr, "Q Max"),
            envAttack: this.#parametric.createParameter(
                box.envAttack,
                ValueMapping.exponential(0.1, 100.0),
                StringMapping.numeric({unit: "ms", fractionDigits: 1}),
                "Attack"),
            envRelease: this.#parametric.createParameter(
                box.envRelease,
                ValueMapping.exponential(1.0, 1000.0),
                StringMapping.numeric({unit: "ms", fractionDigits: 0}),
                "Release"),
            gain: this.#parametric.createParameter(
                box.gain,
                ValueMapping.linear(-20.0, 20.0),
                StringMapping.decible,
                "Gain"),
            mix: this.#parametric.createParameter(
                box.mix, ValueMapping.unipolar(), StringMapping.percent(), "Mix")
        } as const
    }
}
