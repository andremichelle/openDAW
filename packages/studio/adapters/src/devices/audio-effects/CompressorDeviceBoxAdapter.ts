import {CompressorDeviceBox} from "@moises-ai/studio-boxes"
import {Option, StringMapping, UUID, ValueMapping} from "@moises-ai/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@moises-ai/lib-box"
import {Pointers} from "@moises-ai/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class CompressorDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.Compressor

    readonly #context: BoxAdaptersContext
    readonly #box: CompressorDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: CompressorDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): CompressorDeviceBox {return this.#box}
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

    #wrapParameters(box: CompressorDeviceBox) {
        return {
            lookahead: this.#parametric.createParameter(
                box.lookahead, ValueMapping.bool, StringMapping.bool, "Lookahead"),
            automakeup: this.#parametric.createParameter(
                box.automakeup, ValueMapping.bool, StringMapping.bool, "Auto Makeup"),
            autoattack: this.#parametric.createParameter(
                box.autoattack, ValueMapping.bool, StringMapping.bool, "Auto Attack"),
            autorelease: this.#parametric.createParameter(
                box.autorelease, ValueMapping.bool, StringMapping.bool, "Auto Release"),
            inputgain: this.#parametric.createParameter(
                box.inputgain, ValueMapping.linear(-30.0, 30.0), StringMapping.decible, "Input Gain"),
            threshold: this.#parametric.createParameter(
                box.threshold, ValueMapping.linear(-60.0, 0.0), StringMapping.decible, "Threshold"),
            ratio: this.#parametric.createParameter(
                box.ratio, ValueMapping.exponential(1.0, 24.0),
                StringMapping.numeric({fractionDigits: 1}), "Ratio"),
            knee: this.#parametric.createParameter(
                box.knee, ValueMapping.linear(0.0, 24.0), StringMapping.decible, "Knee"),
            attack: this.#parametric.createParameter(
                box.attack, ValueMapping.linear(0.0, 100.0),
                StringMapping.numeric({unit: "ms", fractionDigits: 1}), "Attack Time"),
            release: this.#parametric.createParameter(
                box.release, ValueMapping.linear(5.0, 1500.0),
                StringMapping.numeric({unit: "ms", fractionDigits: 1}), "Release Time"),
            makeup: this.#parametric.createParameter(
                box.makeup, ValueMapping.linear(-40.0, 40.0), StringMapping.decible, "Makeup Gain"),
            mix: this.#parametric.createParameter(
                box.mix, ValueMapping.unipolar(), StringMapping.percent(), "Dry/Wet")
        } as const
    }
}